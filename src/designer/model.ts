/**
 * The designer's document: what the canvas holds, and what is legal in it.
 *
 * This is the file the editor reads and writes (`designer/panel.ui.json` inside the project), and the KDL
 * the firmware compiles is generated from it. Keeping the source of truth separate from the markup is
 * deliberate: the markup is a build artifact whose spelling is dictated by `embedded-gui-codegen`, while the
 * document carries things the markup has no place for -- the canvas coordinates, and which events the user
 * asked for code-behind handlers on.
 *
 * `rustFieldName` mirrors `to_snake_case` in the crate (`parser.rs:941`) exactly, because the generated
 * `struct <Screen>Widgets` is keyed by those names. That function is lossy -- it lowercases capitals without
 * remembering them, and turns spaces and dashes into underscores -- so `MyBtn` and `my_btn` and `my btn` all
 * become `my_btn` and would collide as duplicate struct fields. The validator therefore rejects collisions
 * that the crate would generate, instead of letting the user discover them as a rustc error.
 */

import {
    DEFAULT_OPTIONS,
    DEFAULT_TABLE_HEADERS,
    DEFAULT_TABLE_ROWS,
    KDL_WIDGETS,
    type ChildGrammar,
    type DesignerEvent,
    type KdlCategory,
    widgetSpec,
    widgetRaises,
} from './catalog';
import { NAMED_STYLES, isNamedStyle } from './appearance';
import { isBuiltInFont, supportsFontAttribute, supportsFontStyle } from './fonts';
import { type LcdRotation } from '../display/rotation';

/**
 * Bumped when the on-disk shape changes, so an old document is never misread.
 *
 * Version 2 added `fonts`. Version 1 documents are *migrated* rather than refused (see `migrateDocument` in
 * `store.ts`): the change is purely additive, so refusing them would throw away work for no reason, and a
 * migration seam is what makes the version number worth having at all.
 */
export const DESIGNER_FILE_VERSION = 2;

/** Where the document lives inside a generated project, relative to the project root. */
export const DESIGNER_DOCUMENT_PATH = 'designer/panel.ui.json';

/** Where the generated markup lives, relative to the project root. Read by `include_gui!`. */
export const DESIGNER_KDL_PATH = 'src/ui.kdl';

/** The module the project's `main.rs` calls into, written once alongside it. */
export const DESIGNER_MODULE_PATH = 'src/ui.rs';

/** The code-behind the user owns, written once and never regenerated. */
export const DESIGNER_HANDLERS_PATH = 'src/ui_handlers.rs';

/**
 * A font the design declares, which widgets then refer to by name.
 *
 * A widget never names a font *file*: it names a font the screen declared, and the markup's parser drops the
 * reference without a word if no declaration matches. The file itself is a BDF -- that is the only format the
 * crate's asset loader parses -- and it is embedded into the firmware at build time, so `chars` is worth
 * setting: a design that only ever shows digits pays for nothing else.
 */
export interface DesignerFont {
    /** The name widgets use, and the one the generated Rust constant is made from. */
    id: string;
    /** The BDF file, relative to the project root. */
    src: string;
    /** Which characters to embed; empty means all of them. */
    chars: string;
}

/** One layer of a composite icon: an asset plus where it sits inside the icon's box. */
export interface DesignerIconPart {
    src: string;
    x: number;
    y: number;
    visible: boolean;
    tint: string;
}

/**
 * The children a widget's body holds, when its grammar has one.
 *
 * Kept as a discriminated union rather than a bag of optional fields so the emitter has to handle every
 * grammar explicitly, and so a table can never be carrying a stale option list.
 */
export type DesignerChildren =
    | { kind: 'options'; values: string[] }
    | { kind: 'table'; headers: string[]; rows: string[][] }
    | { kind: 'parts'; parts: DesignerIconPart[] };

export interface DesignerWidget {
    /** The user-facing name. Also becomes the Rust struct field and the handler prefix. */
    id: string;
    /** A canonical tag from the catalogue. */
    tag: string;
    /** Canvas position and size in whole pixels, inside the designed area. */
    x: number;
    y: number;
    width: number;
    height: number;
    /** Values for the properties the catalogue lists for this tag, keyed by the KDL attribute name. */
    props: Record<string, string | number | boolean>;
    /** The events that get a code-behind handler. Only events the widget actually raises are legal. */
    events: DesignerEvent[];
    /** The body, for the five tags the parser reads children from. Absent for everything else. */
    children?: DesignerChildren;
}

export interface DesignerDocument {
    version: number;
    /** The board the panel belongs to, so a document opened elsewhere can say what it was designed for. */
    boardId: string;
    /** The panel's native size. The designed area is derived from this and the rotation. */
    panelWidth: number;
    panelHeight: number;
    rotation: LcdRotation;
    /** The `screen` node's own attributes. There is no background: the markup has no such attribute. */
    screenId: string;
    theme: string;
    /** Fonts the screen declares, which the widgets' `font` properties refer to by name. */
    fonts: DesignerFont[];
    widgets: DesignerWidget[];
}

/**
 * The area the canvas shows, which is the panel's own extent turned with it.
 *
 * A 90 or 270 degree rotation swaps the axes, exactly as `mipidsi` swaps its drawing area for those
 * orientations, so a landscape panel is designed in landscape rather than sideways.
 */
export function designCanvasSize(
    panelWidth: number,
    panelHeight: number,
    rotation: LcdRotation,
): { width: number; height: number } {
    const swaps = rotation === 1 || rotation === 3;
    return swaps ? { width: panelHeight, height: panelWidth } : { width: panelWidth, height: panelHeight };
}

/** The default screen id, derived from the project name so a copied project is not a duplicate id. */
export function screenIdFrom(projectName: string): string {
    const cleaned = projectName.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, 's$1');
    return cleaned === '' ? 'Panel' : cleaned;
}

/**
 * Mirrors `to_snake_case` in `embedded-gui-codegen` (`parser.rs:941`).
 *
 * Duplicated here on purpose rather than approximated: this is the function that decides the generated
 * struct's field names, so an id that survives it unchanged is an id that cannot collide.
 */
export function rustFieldName(id: string): string {
    let out = '';
    let first = true;
    for (const c of id) {
        if (c >= 'A' && c <= 'Z') {
            if (!first) {
                out += '_';
            }
            out += c.toLowerCase();
        } else if (c === '-' || c === ' ') {
            out += '_';
        } else {
            out += c;
        }
        first = false;
    }
    return out;
}

/**
 * Mirrors `font_const_name` in `embedded-gui-codegen`, which is what a font name becomes in the generated Rust.
 *
 * Two names that differ only in punctuation -- `big-font` and `big font` -- both become `__FONT_BIG_FONT`, and
 * the second would silently use the first's data. Validation refuses that rather than letting the compiler
 * report a duplicate constant.
 */
export function fontConstName(id: string): string {
    let out = '__FONT_';
    for (const c of id) {
        out += /[A-Za-z0-9]/.test(c) ? c.toUpperCase() : '_';
    }
    return out;
}

/** True when a name can be a font id: the generated Rust constant is built from it, so keep it tame. */
export function isFontId(value: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** A fresh document for a board, with no widgets. */
export function createDocument(options: {
    boardId: string;
    panelWidth: number;
    panelHeight: number;
    rotation: LcdRotation;
    screenId: string;
}): DesignerDocument {
    return {
        version: DESIGNER_FILE_VERSION,
        boardId: options.boardId,
        panelWidth: options.panelWidth,
        panelHeight: options.panelHeight,
        rotation: options.rotation,
        screenId: options.screenId,
        theme: 'dark',
        fonts: [],
        widgets: [],
    };
}

/** The properties a dropped widget starts with, so its markup is always complete. */
export function defaultProps(tag: string): Record<string, string | number | boolean> {
    const spec = widgetSpec(tag);
    const props: Record<string, string | number | boolean> = {};
    for (const property of spec?.props ?? []) {
        // A superseded property is not part of a new widget: it exists so a design that names it still loads.
        if (property.legacy === true) {
            continue;
        }
        props[property.name] = property.defaultValue;
    }
    return props;
}

/**
 * The body a dropped widget starts with.
 *
 * An icon is the one that cannot be defaulted into something useful: its parts must name real asset files,
 * so it starts with none and the validator says so until the user picks one. The alternatives -- inventing a
 * path, or leaving the widget out of the Toolbox -- would be worse: the first writes markup that fails to
 * build, the second hides a widget the crate supports.
 */
export function defaultChildren(tag: string): DesignerChildren | undefined {
    const grammar: ChildGrammar | undefined = widgetSpec(tag)?.children;
    switch (grammar) {
        case 'options':
            return { kind: 'options', values: [...DEFAULT_OPTIONS] };
        case 'table':
            return {
                kind: 'table',
                headers: [...DEFAULT_TABLE_HEADERS],
                rows: DEFAULT_TABLE_ROWS.map((row) => [...row]),
            };
        case 'parts':
            return { kind: 'parts', parts: [] };
        default:
            return undefined;
    }
}

/** A widget id that is free in this document, e.g. `button`, `button_2`, `button_3`. */
export function uniqueWidgetId(document: DesignerDocument, tag: string): string {
    const taken = new Set(document.widgets.map((widget) => widget.id));
    if (!taken.has(tag)) {
        return tag;
    }
    for (let n = 2; ; n += 1) {
        const candidate = `${tag}_${n}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
}

/**
 * Where a widget of this tag fits if dropped at a point, nudged until it is inside the panel.
 *
 * Dropping near an edge must not produce a document that fails validation, so the rectangle is slid back
 * inside rather than clamped (which would shrink it and silently change its default size).
 */
export function placeWidget(
    tag: string,
    x: number,
    y: number,
    canvas: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
    const spec = widgetSpec(tag);
    const width = Math.max(1, Math.min(spec?.defaultSize.width ?? 48, canvas.width));
    const height = Math.max(1, Math.min(spec?.defaultSize.height ?? 48, canvas.height));
    return {
        x: Math.max(0, Math.min(Math.round(x), canvas.width - width)),
        y: Math.max(0, Math.min(Math.round(y), canvas.height - height)),
        width,
        height,
    };
}

/**
 * The circle a shape widget stands for, derived from its bounding rect.
 *
 * A designer-native circle is carried as an ordinary rect -- its bounding box -- so every existing rule for
 * moving, resizing, snapping and hitting it still applies. The centre and radius below are only a different
 * view of that same rectangle, offered to the property panel and used to paint the arc. Keeping the rect as
 * the single source of truth is what avoids a second pair of fields that a drag could leave out of step.
 */
export function circleCentre(widget: DesignerWidget): { cx: number; cy: number } {
    return {
        cx: widget.x + Math.floor(widget.width / 2),
        cy: widget.y + Math.floor(widget.height / 2),
    };
}

/**
 * The radius of the disc inscribed in a widget's box, in whole pixels: half its shorter side.
 *
 * This is the Geometry panel's number, and it is the same radius the disc is *drawn* with (the renderer
 * inscribes the disc in the box, centred on the box's centre). It deliberately does not try to keep the disc
 * inside the box on its own: that is the renderer's job, and it does it by measuring in half-pixels -- see the
 * note in `rusty-gui-widgets`. Trying to do it here made the panel's radius one less than the drawn one.
 */
export function circleRadius(widget: DesignerWidget): number {
    return Math.floor(Math.min(widget.width, widget.height) / 2);
}

/** The square box a circle of the given centre and radius occupies, which is the inverse of the two above. */
export function circleRect(
    centreX: number,
    centreY: number,
    radius: number,
): { x: number; y: number; width: number; height: number } {
    const r = Math.max(0, radius);
    return { x: centreX - r, y: centreY - r, width: r * 2, height: r * 2 };
}

/**
 * A triangle's three vertices as six per-mille offsets into its box: `[p1x, p1y, p2x, p2y, p3x, p3y]`.
 *
 * Per-mille of the box rather than pixels, because the box is the one thing the designer and the board
 * share exactly: the grid hands the widget its cell, so `x + p * w / 1000` puts a vertex in the same place on
 * the canvas and on the glass without either side knowing the other's arithmetic. It also means the triangle
 * scales with its box -- resizing the box scales the shape instead of moving one lonely vertex.
 *
 * The attribute names are the KDL ones, in order, so the catalogue's six properties and this tuple cannot
 * drift apart: the panel writes them, `kdl.ts` emits them, and the crate's parser reads them as `p1x`..`p3y`.
 */
export type TrianglePoints = [number, number, number, number, number, number];

/** The six KDL attribute names, in the order `TrianglePoints` counts in. */
export const TRIANGLE_POINT_NAMES = ['p1x', 'p1y', 'p2x', 'p2y', 'p3x', 'p3y'] as const;

/** The three vertices as indices into `TrianglePoints`, for a drag handle and for the panel's rows. */
export type TriangleVertex = 0 | 1 | 2;

export const TRIANGLE_VERTICES: TriangleVertex[] = [0, 1, 2];

/** The isosceles triangle a freshly dropped one is: apex on the top edge centre, base along the bottom edge. */
export const DEFAULT_TRIANGLE_POINTS: TrianglePoints = [500, 0, 0, 1000, 1000, 1000];

/** A triangle's box and its six offsets together, which is everything its geometry needs. */
export interface TriangleBox {
    x: number;
    y: number;
    width: number;
    height: number;
    points: TrianglePoints;
}

function clampInt(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, Math.round(value)));
}

/**
 * A widget's six offsets, falling back to the default triangle.
 *
 * A document written before the vertices could be dragged has none of the six properties, and the crate's
 * `Triangle` has the same default, so the old design keeps the shape it always had on both sides rather than
 * needing a migration.
 */
export function trianglePoints(widget: DesignerWidget): TrianglePoints {
    // Per offset, not all-or-nothing: the crate's parser reads each of the six with its own default, so a
    // document that names two of them gets those two and the crate's value for the rest -- which is what
    // `parser.rs` does on the other side.
    return TRIANGLE_POINT_NAMES.map((name, index) => {
        const value = widget.props[name];
        const fallback = DEFAULT_TRIANGLE_POINTS[index] ?? 0;
        return typeof value === 'number' && Number.isFinite(value) ? clampInt(value, 0, 1000) : fallback;
    }) as TrianglePoints;
}

/** A triangle widget's box and offsets together, with the points the document leaves out filled in. */
export function triangleBoxOf(widget: DesignerWidget): TriangleBox {
    return { x: widget.x, y: widget.y, width: widget.width, height: widget.height, points: trianglePoints(widget) };
}

/**
 * One vertex of a triangle in panel pixels, by the same rule the crate's `Triangle::vertices` uses.
 *
 * The crate measures in whole pixels inside the cell (`p * w / 1000`, clamped to the box), so a vertex at
 * `1000` is the box's *last* pixel and not one beyond it: a triangle can never paint outside its own cell,
 * which is what keeps it inside the engine's clip. Doing the same rounding here means the handle the user
 * grabs sits on the pixel the board paints, not half a pixel away from it.
 */
export function triangleVertex(box: TriangleBox, vertex: TriangleVertex): { x: number; y: number } {
    const w = Math.max(1, Math.round(box.width));
    const h = Math.max(1, Math.round(box.height));
    // A tuple of six, indexed by a vertex in 0..=2, so both are always there; the defaults are unreachable
    // and only satisfy the index check.
    const px = box.points[vertex * 2] ?? 0;
    const py = box.points[vertex * 2 + 1] ?? 0;
    return {
        x: clampInt(box.x + Math.floor((px * w) / 1000), box.x, box.x + w - 1),
        y: clampInt(box.y + Math.floor((py * h) / 1000), box.y, box.y + h - 1),
    };
}

/** The three vertices in panel pixels, in point order, which is the inverse of `triangleFromVertices`. */
export function triangleVertices(box: TriangleBox): { x: number; y: number }[] {
    return TRIANGLE_VERTICES.map((vertex) => triangleVertex(box, vertex));
}

/**
 * The box and offsets for three vertices in panel pixels: the inverse of `triangleVertices`.
 *
 * The box is the three vertices' bounding rectangle measured in whole pixels, so dragging one vertex moves
 * the box with it and the other two stay exactly where they were -- which is what lets a point be dragged
 * anywhere on the glass instead of only inside the box it started in. The offsets are chosen so that the
 * round trip through the crate's own arithmetic returns the same pixel: the box is `span + 1` pixels wide
 * (its last pixel is a real pixel), so a vertex at the far edge comes back as `1000` and not `999`.
 */
export function triangleFromVertices(
    vertices: readonly { x: number; y: number }[],
): { x: number; y: number; width: number; height: number; points: TrianglePoints } {
    const xs = vertices.map((vertex) => Math.round(vertex.x));
    const ys = vertices.map((vertex) => Math.round(vertex.y));
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(1, Math.max(...xs) - x + 1);
    const height = Math.max(1, Math.max(...ys) - y + 1);
    const points: number[] = [];
    for (const vertex of vertices) {
        points.push(pointOf(Math.round(vertex.x), x, width), pointOf(Math.round(vertex.y), y, height));
    }
    // Six values by construction: three vertices, two coordinates each.
    return { x, y, width, height, points: points as TrianglePoints };
}

/**
 * One pixel of a box as a per-mille offset, chosen so that `triangleVertex` lands back on that same pixel.
 *
 * Rounded **up**, which is not the obvious choice. The crate measures forward by truncating (`p * size /
 * 1000`), so rounding the fraction down here comes back a pixel short: the 55th pixel of a 56-pixel box is
 * 982.1 per-mille, and 982 per-mille of 56 pixels is 54.9 -- the 54th. Rounding up makes it 983, and 983
 * per-mille of 56 is 55.0 -- the 55th, which is where the user let go of it.
 */
function pointOf(pixel: number, origin: number, size: number): number {
    const span = pixel - origin;
    if (span <= 0) {
        return 0;
    }
    if (span >= size) {
        return 1000;
    }
    return Math.min(1000, Math.ceil((span * 1000) / size));
}

function isRustIdentifier(value: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** A tag as a sentence reads it, for a message about a widget. */
function widgetLabel(tag: string): string {
    return widgetSpec(tag)?.label.toLowerCase() ?? tag;
}

/**
 * The properties a widget carries that its tag has no place for.
 *
 * The catalogue is the authority, so this is the list `validateDocument` reads, asked once more rather than
 * written down twice: the validator refuses a design over one of these keys and the load path drops it, and
 * those two answers have to be the same answer.
 *
 * An unknown *tag* is deliberately not this function's business. A widget the markup no longer offers is
 * somebody's work, and clearing it away silently would be losing it; the validator reports it instead.
 */
export function unknownProps(widget: DesignerWidget): string[] {
    const spec = widgetSpec(widget.tag);
    if (spec === undefined) {
        return [];
    }
    return Object.keys(widget.props).filter((key) => !spec.props.some((property) => property.name === key));
}

export interface CleanedDesign {
    /** The design, with the properties this version has no place for removed. */
    document: DesignerDocument;
    /** One sentence per property that went, for the panel and the output channel. Empty when none did. */
    dropped: string[];
}

/**
 * Drops the properties the catalogue no longer has a place for.
 *
 * This runs when a design is *loaded*, and it is the difference between an older document working and an older
 * document freezing. `validateDocument` refuses a whole design over a single unknown key, and `renderDesign`
 * only writes the markup for a design that validates -- so one leftover property stops `src/ui.kdl` being
 * written at all. The canvas goes on accepting edits, the board goes on compiling the markup from the last
 * save that worked, and nothing connects the two. Seen for real: a checkbox carrying the `style` property
 * from before the appearance fields existed, which no version of the catalogue has offered since, leaving a
 * panel drawing `RUN` while the canvas showed a box labelled `Swing it!`.
 *
 * Only *keys* are dropped. A property whose value this version disagrees with -- a size past the maximum, a
 * colour that is not one -- is a mistake to be shown rather than junk to be cleared away, so it stays and the
 * panel reports it.
 *
 * A design with nothing to drop is handed back as it came, and that is what lets the caller tell the two
 * apart by `dropped.length` and leave the project's files alone.
 */
export function dropUnknownProps(document: DesignerDocument): CleanedDesign {
    const dropped: string[] = [];
    const widgets = document.widgets.map((widget) => {
        const unknown = unknownProps(widget);
        if (unknown.length === 0) {
            return widget;
        }
        const props = { ...widget.props };
        for (const key of unknown) {
            delete props[key];
            dropped.push(`"${widget.id}": "${key}" is not a property of a ${widgetLabel(widget.tag)} any more`);
        }
        return { ...widget, props };
    });
    return dropped.length === 0 ? { document, dropped } : { document: { ...document, widgets }, dropped };
}

/**
 * Everything wrong with a document, as sentences the editor can show.
 *
 * Returns reasons rather than throwing, because the editor validates a document the user is mid-way through
 * building: a problem is a message next to the offending widget, not an exception that loses the canvas.
 * The emitter and `layoutToGrid` are the strict half -- they may assume a validated document.
 */
export function validateDocument(document: DesignerDocument): string[] {
    const problems: string[] = [];

    if (document.version !== DESIGNER_FILE_VERSION) {
        problems.push(
            `this document is version ${document.version}, and this extension reads version ${DESIGNER_FILE_VERSION}`,
        );
    }
    if (!isRustIdentifier(document.screenId)) {
        problems.push(`the screen id "${document.screenId}" is not a valid Rust identifier`);
    }

    const canvas = designCanvasSize(document.panelWidth, document.panelHeight, document.rotation);
    const seenIds = new Map<string, string>();
    const seenFields = new Map<string, string>();

    const fonts = document.fonts ?? [];
    const fontIds = new Set<string>();
    const fontConstants = new Map<string, string>();
    for (const font of fonts) {
        const where = font.id === '' ? '(unnamed font)' : `font "${font.id}"`;
        if (!isFontId(font.id)) {
            problems.push(
                `${where}: the name must start with a letter and contain only letters, digits and underscores`,
            );
        } else if (fontIds.has(font.id)) {
            problems.push(`${where}: two fonts have this name`);
        } else {
            fontIds.add(font.id);
            const constant = fontConstName(font.id);
            const clash = fontConstants.get(constant);
            if (clash !== undefined) {
                problems.push(
                    `${where}: the name becomes ${constant} in the generated code, which "${clash}" already uses`,
                );
            } else {
                fontConstants.set(constant, font.id);
            }
        }
        if (font.src.trim() === '') {
            problems.push(`${where}: no font file has been chosen`);
        } else if (!font.src.toLowerCase().endsWith('.bdf')) {
            // The crate's asset loader parses BDF and nothing else, so say so here rather than at build time.
            problems.push(`${where}: "${font.src}" is not a .bdf file, and BDF is the only format the loader reads`);
        }
    }

    for (const widget of document.widgets) {
        const where = widget.id === '' ? '(unnamed widget)' : `"${widget.id}"`;

        for (const complaint of sdImageSourceProblems(widget)) {
            problems.push(`${where}: ${complaint}`);
        }

        if (!isRustIdentifier(widget.id)) {
            problems.push(`${where}: the id must start with a letter and contain only letters, digits and underscores`);
        } else {
            const field = rustFieldName(widget.id);
            const existingId = seenFields.get(field);
            if (existingId !== undefined && existingId !== widget.id) {
                problems.push(
                    `${where}: the id becomes "${field}" in the generated code, which "${existingId}" already uses`,
                );
            } else {
                seenFields.set(field, widget.id);
            }
            if (seenIds.has(widget.id)) {
                problems.push(`${where}: the id is used more than once`);
            } else {
                seenIds.set(widget.id, widget.id);
            }
        }

        const spec = widgetSpec(widget.tag);
        if (spec === undefined) {
            problems.push(`${where}: "${widget.tag}" is not one of the widgets the markup supports`);
        } else {
            for (const property of spec.props) {
                const value = widget.props[property.name];
                if (value === undefined) {
                    // An optional property the crate itself defaults may simply not be named. Refusing it
                    // would reject every design written before the property existed, which is why the
                    // catalogue has to say which ones those are rather than the validator guessing.
                    if (property.optional !== true) {
                        problems.push(`${where}: ${property.label} is missing`);
                    }
                    continue;
                }
                const complaint = propertyProblem(property, value);
                if (complaint !== undefined) {
                    problems.push(`${where}: ${property.label} ${complaint}`);
                } else if (property.required === true && value === '') {
                    problems.push(`${where}: ${property.label} is required and has not been chosen`);
                }
            }
            for (const key of unknownProps(widget)) {
                problems.push(`${where}: "${key}" is not a property of a ${spec.label.toLowerCase()}`);
            }
            for (const event of widget.events) {
                if (!widgetRaises(widget.tag, event)) {
                    problems.push(`${where}: a ${spec.label.toLowerCase()} does not raise ${event}`);
                }
            }
            if (spec.unavailable !== undefined) {
                // Refused rather than emitted: the crate writes this widget's builder call itself, and there is
                // no markup that makes it compile. Saying so here is the difference between a design that
                // cannot be built and a design that explains why.
                problems.push(`${where}: ${spec.unavailable}`);
            }
            const style = widget.props.style;
            if (typeof style === 'string' && style !== '' && !isNamedStyle(style)) {
                // The resolver passes a name it does not know through *verbatim*, as Rust. A typo would not be
                // ignored, it would be compiled -- and a hand-edited design file is exactly where one appears.
                problems.push(
                    `${where}: "${style}" is not a base style the crate knows ` +
                    `(${NAMED_STYLES.map((named) => named.id).join(', ')})`,
                );
            }
            const font = widget.props.font;
            if (typeof font === 'string' && font !== '') {
                if (isBuiltInFont(font)) {
                    // A built-in travels as a style expression, since the markup has no attribute for the
                    // crate's own fonts. A widget with no style handle cannot carry one at all.
                    if (!supportsFontStyle(spec.fontSupport)) {
                        problems.push(
                            `${where}: the crate has no style handle for a ${spec.label.toLowerCase()}, ` +
                            `so the built-in font "${font}" could not reach it`,
                        );
                    }
                } else if (!fontIds.has(font)) {
                    // Worth an error rather than a shrug: the markup's parser ignores a font it cannot resolve
                    // without saying anything, so a typo here would look like "the font did nothing".
                    problems.push(`${where}: no font named "${font}" is declared on the screen`);
                } else if (!supportsFontAttribute(spec.fontSupport)) {
                    // The same silence, one step further out: the name resolves, but the crate only reads
                    // `font` for labels and carousels, so a button or a table would drop it without a word.
                    problems.push(
                        `${where}: the crate reads a declared font for labels and carousels only, so ` +
                        `"${font}" would be ignored on a ${spec.label.toLowerCase()}`,
                    );
                }
            }
            problems.push(...childrenProblems(widget, spec.children, spec.label));
        }

        for (const [name, value] of [
            ['x', widget.x],
            ['y', widget.y],
            ['width', widget.width],
            ['height', widget.height],
        ] as const) {
            if (!Number.isInteger(value)) {
                problems.push(`${where}: ${name} must be a whole number of pixels, got ${value}`);
            }
        }
        if (widget.width < 1 || widget.height < 1) {
            problems.push(`${where}: the widget must be at least 1x1, got ${widget.width}x${widget.height}`);
        } else if (widget.x < 0 || widget.y < 0) {
            problems.push(`${where}: the origin cannot be negative, got (${widget.x}, ${widget.y})`);
        } else if (widget.x + widget.width > canvas.width || widget.y + widget.height > canvas.height) {
            problems.push(
                `${where}: ${widget.width}x${widget.height} at (${widget.x}, ${widget.y}) runs past the ` +
                `${canvas.width}x${canvas.height} canvas`,
            );
        }
    }

    return problems;
}

/**
 * The body's own problems: the wrong grammar, or a grammar the parser will reject.
 *
 * The strictest rule here is the icon's: `embedded-gui-codegen` returns `MissingAttribute` for a composite
 * icon with no `part` child, so a document that would fail to build has to be caught here, while the user is
 * still looking at the canvas, rather than at the next compile.
 */
function childrenProblems(
    widget: DesignerWidget,
    grammar: ChildGrammar | undefined,
    label: string,
): string[] {
    const problems: string[] = [];
    const children = widget.children;

    if (grammar === undefined) {
        if (children !== undefined) {
            problems.push(`"${widget.id}": a ${label.toLowerCase()} does not take a body`);
        }
        return problems;
    }
    if (children === undefined) {
        problems.push(`"${widget.id}": a ${label.toLowerCase()} needs a body`);
        return problems;
    }

    if (grammar === 'options') {
        if (children.kind !== 'options') {
            problems.push(`"${widget.id}": expected a list of options, found a ${children.kind} body`);
            return problems;
        }
        if (children.values.length === 0) {
            problems.push(`"${widget.id}": the option list is empty`);
        }
        children.values.forEach((value, index) => {
            if (value.trim() === '') {
                problems.push(`"${widget.id}": option ${index + 1} is empty`);
            }
        });
        const selected = widget.props.selected;
        if (typeof selected === 'number' && children.values.length > 0 && selected >= children.values.length) {
            problems.push(
                `"${widget.id}": the selected index ${selected} is past the end of the ` +
                `${children.values.length}-option list`,
            );
        }
        return problems;
    }

    if (grammar === 'table') {
        if (children.kind !== 'table') {
            problems.push(`"${widget.id}": expected table headers and rows, found a ${children.kind} body`);
            return problems;
        }
        if (children.rows.some((row) => row.length !== children.headers.length)) {
            problems.push(
                `"${widget.id}": every row must have ${children.headers.length} cells, ` +
                `the same as the ${children.headers.length} headers`,
            );
        }
        return problems;
    }

    if (children.kind !== 'parts') {
        problems.push(`"${widget.id}": expected icon parts, found a ${children.kind} body`);
        return problems;
    }
    if (children.parts.length === 0) {
        problems.push(`"${widget.id}": a composite icon needs at least one part with an asset`);
    }
    children.parts.forEach((part, index) => {
        if (part.src.trim() === '') {
            problems.push(`"${widget.id}": part ${index + 1} has no asset`);
        }
    });
    return problems;
}

/** One property's value checked against what its editor can produce. */
function propertyProblem(
    property: { kind: string; name: string; options?: readonly string[]; min?: number; max?: number },
    value: string | number | boolean,
): string | undefined {
    switch (property.kind) {
        case 'text':
        case 'asset':
            return typeof value === 'string' ? undefined : `must be text, got ${typeof value}`;
        case 'bool':
            return typeof value === 'boolean' ? undefined : `must be true or false, got ${typeof value}`;
        case 'int':
            if (typeof value !== 'number' || !Number.isInteger(value)) {
                return `must be a whole number, got ${value}`;
            }
            if (property.min !== undefined && value < property.min) {
                return `cannot be less than ${property.min}`;
            }
            if (property.max !== undefined && value > property.max) {
                return `cannot be more than ${property.max}`;
            }
            return undefined;
        case 'float':
            return typeof value === 'number' && Number.isFinite(value)
                ? undefined
                : `must be a number, got ${value}`;
        case 'enum':
            return property.options?.includes(String(value))
                ? undefined
                : `must be one of ${property.options?.join(', ')}, got ${value}`;
        case 'color':
            // An empty string means "not set", which is how an optional tint stays absent from the markup.
            if (value === '') {
                return undefined;
            }
            return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
                ? undefined
                : `must be a #rrggbb colour or empty, got ${value}`;
        default:
            return undefined;
    }
}

/**
 * What is wrong with an image that names a file on the SD card, if anything.
 *
 * The card is reached with a **short 8.3 name** and from its root, because `embedded-sdmmc` in a generated
 * project is built without an allocator and so cannot assemble long names, and because opening a subdirectory
 * is a second handle this version does not keep. Both are worth refusing here: a name the driver cannot open
 * is an image that silently never appears on the glass.
 */
export function sdImageSourceProblems(widget: DesignerWidget): string[] {
    const path = cardSourcePath(widget.props.src);
    if (path === undefined) {
        return [];
    }
    if (path === '') {
        return ['the SD card path is empty, so there is no file to read'];
    }
    if (path.includes('/')) {
        return [
            `"${path}" is in a subdirectory, and cards are read from their root: use sd:NAME.BMP`,
        ];
    }
    if (!/^[A-Za-z0-9_]{1,8}(\.[A-Za-z0-9_]{1,3})?$/.test(path)) {
        return [
            `"${path}" is not a short file name, and the card is read without long-name support: use something ` +
            'like sd:PIC1.BMP',
        ];
    }
    return [];
}

/**
 * The images whose pixels come from the SD card, by widget id.
 *
 * Separate from the validation above because whether the *card* exists is a property of the board rather than
 * of the design, and this module deliberately knows nothing about boards. The caller decides what to say.
 */
export function sdImagesNeedingCard(widgets: readonly DesignerWidget[]): string[] {
    return widgets
        .filter(
            (widget) => widget.tag === 'image' && cardSourcePath(widget.props.src) !== undefined,
        )
        .map((widget) => widget.id);
}

/**
 * The card path an image source names, or `undefined` when it names a file in the project instead.
 *
 * The `sd:` prefix is matched without regard to case, and it is matched in one place so the checks that hang off
 * it -- is this name a short one, does this board have a socket, is the pixels' file missing -- all agree with
 * the parser in a generated project. `SD:PIC1.BMP` is what a card in a file manager is called; treating it as an
 * asset would ask the build machine for a file that only exists on the card.
 */
export function cardSourcePath(source: unknown): string | undefined {
    if (typeof source !== 'string' || source.slice(0, 3).toLowerCase() !== 'sd:') {
        return undefined;
    }
    return source.slice(3).replace(/^\//, '');
}

/** The tags the Toolbox offers, in catalogue order, for a board whose panel this is. */
export function toolboxTags(): { tag: string; category: KdlCategory; label: string }[] {
    return KDL_WIDGETS.map((widget) => ({
        tag: widget.tag,
        category: widget.category,
        label: widget.label,
    }));
}
