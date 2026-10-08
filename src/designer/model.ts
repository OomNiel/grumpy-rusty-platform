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

function isRustIdentifier(value: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
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
                    problems.push(`${where}: ${property.label} is missing`);
                    continue;
                }
                const complaint = propertyProblem(property, value);
                if (complaint !== undefined) {
                    problems.push(`${where}: ${property.label} ${complaint}`);
                } else if (property.required === true && value === '') {
                    problems.push(`${where}: ${property.label} is required and has not been chosen`);
                }
            }
            for (const key of Object.keys(widget.props)) {
                if (!spec.props.some((property) => property.name === key)) {
                    problems.push(`${where}: "${key}" is not a property of a ${spec.label.toLowerCase()}`);
                }
            }
            for (const event of widget.events) {
                if (!widgetRaises(widget.tag, event)) {
                    problems.push(`${where}: a ${spec.label.toLowerCase()} does not raise ${event}`);
                }
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

/** The tags the Toolbox offers, in catalogue order, for a board whose panel this is. */
export function toolboxTags(): { tag: string; category: KdlCategory; label: string }[] {
    return KDL_WIDGETS.map((widget) => ({
        tag: widget.tag,
        category: widget.category,
        label: widget.label,
    }));
}
