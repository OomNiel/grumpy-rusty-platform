/**
 * Reading and writing a design: the document on disk, and the markup generated from it.
 *
 * Deliberately free of `vscode` and of `fs`, in the same shape as `display/rotation.ts`: the extension does
 * the file access and this module does the text. That keeps the interesting parts -- refusing a document from
 * a future version, deciding what is written when the design does not validate -- testable without a
 * workspace.
 *
 * The two artifacts have different rules, which is the point of `renderDesign`:
 *
 * - The **document** is always written, valid or not. It is the user's work; an invalid design must survive
 *   being closed, or a mistake would cost the whole canvas.
 * - The **markup** is only written when the design validates. `include_gui!` reads it at compile time, and a
 *   half-finished design would turn every build into a codegen error rather than preserving the last thing
 *   that worked.
 */

import {
    type DesignerDocument,
    DESIGNER_FILE_VERSION,
    type DesignerFont,
    validateDocument,
} from './model';
import { emitKdl } from './kdl';

export interface LoadResult {
    document?: DesignerDocument;
    /** Why the file could not be used, in a sentence the panel can show instead of a blank canvas. */
    error?: string;
}

/**
 * Parses a stored document.
 *
 * A missing file is not an error -- a designer template starts with an empty design -- so the caller passes
 * `''` and gets `undefined` back with no complaint. Anything else that cannot be read is reported, because a
 * silently empty canvas over an existing file is how work gets lost.
 */
export function loadDocument(json: string): LoadResult {
    if (json.trim() === '') {
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (error) {
        return { error: `the design file is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { error: 'the design file does not contain an object' };
    }

    const candidate = parsed as Partial<DesignerDocument>;
    if (candidate.boardId === undefined || !Array.isArray(candidate.widgets)) {
        return { error: 'the design file is missing its board or its widgets' };
    }
    return migrateDocument(candidate);
}

/**
 * Brings a stored document up to the current shape.
 *
 * Version 1 had no `fonts`, so it migrates by gaining an empty list -- refusing it would throw away work over
 * a field that did not exist yet. Anything else is refused with both versions named, because a document from a
 * newer extension may carry fields this one would silently drop on the next save.
 */
function migrateDocument(candidate: Partial<DesignerDocument>): LoadResult {
    const version = candidate.version;
    if (version === 1) {
        return {
            document: { ...(candidate as DesignerDocument), version: DESIGNER_FILE_VERSION, fonts: [] },
        };
    }
    if (version !== DESIGNER_FILE_VERSION) {
        return {
            error:
                `the design file says it is version ${String(version)}, and this extension reads version ` +
                `${DESIGNER_FILE_VERSION}`,
        };
    }
    return {
        document: {
            ...(candidate as DesignerDocument),
            // A document written by hand, or by a version that predates the field, still loads: an absent list
            // is an empty one, not a broken file.
            fonts: Array.isArray(candidate.fonts) ? (candidate.fonts as DesignerFont[]) : [],
        },
    };
}

export interface RenderedDesign {
    /** What to write to the document file. Always present: the work is never thrown away. */
    documentJson: string;
    /** What to write to the markup file, or `undefined` when the design does not validate. */
    kdl?: string;
    /** Why the markup was not written, when it was not. */
    problems: string[];
}

/**
 * Serialises a design for writing.
 *
 * The JSON is indented and newline-terminated so the file is reviewable in a diff: a design is a source file
 * that belongs in version control, and a single line of JSON would make every change look like a rewrite.
 */
export function renderDesign(document: DesignerDocument): RenderedDesign {
    const documentJson = `${JSON.stringify(document, null, 2)}\n`;
    const problems = validateDocument(document);
    if (problems.length > 0) {
        return { documentJson, problems };
    }
    try {
        return { documentJson, kdl: emitKdl(document), problems: [] };
    } catch (error) {
        // The validator and the emitter disagree, which is a bug rather than a user error -- but the
        // document still gets written, and the panel is told why the markup did not.
        return {
            documentJson,
            problems: [`the markup could not be generated: ${error instanceof Error ? error.message : String(error)}`],
        };
    }
}

/**
 * Problems that only the extension can see, because they are about files rather than about the document.
 *
 * An `image` or a `mesh` names an asset and the crate's macro reads that file at compile time: a design that
 * passes every document check still fails to build if the asset is not there. The check lives here rather
 * than in the validator because it needs the project's directory.
 */
export function missingAssets(
    document: DesignerDocument,
    exists: (relativePath: string) => boolean,
): string[] {
    const problems: string[] = [];
    for (const font of document.fonts ?? []) {
        if (font.src !== '' && !exists(font.src)) {
            problems.push(`the font "${font.id}" names "${font.src}", which is not in the project`);
        }
    }
    for (const widget of document.widgets) {
        const source = widget.props.src;
        if (typeof source === 'string' && source !== '' && !exists(source)) {
            problems.push(`"${widget.id}": the asset "${source}" is not in the project`);
        }
        if (widget.children?.kind === 'parts') {
            widget.children.parts.forEach((part, index) => {
                if (part.src !== '' && !exists(part.src)) {
                    problems.push(`"${widget.id}": part ${index + 1} names "${part.src}", which is not in the project`);
                }
            });
        }
    }
    return problems;
}

/**
 * Where a chosen file goes, and under what path the design should refer to it.
 *
 * A design names its assets relative to the project root -- that is what the generated `project.kdl` anchors --
 * so a file picked from somewhere else on the disk has to be brought in rather than referenced: `../../../x.bdf`
 * would work until the folder moved, and then fail at build time with a path nobody recognises.
 *
 * Pure, and separated from the copying itself, so the decisions worth testing (is it inside? does the name
 * clash? what is the path?) are tested without touching a filesystem.
 */
export interface AssetImport {
    /** The path to store in the design, relative to the project root. */
    relativePath: string;
    /** The file to copy first, when the choice lies outside the project. */
    copyFrom?: string;
}

/** Where imported files are put, and the only folder the generated project knows about. */
export const ASSET_DIRECTORY = 'assets';

export function planAssetImport(options: {
    /** The absolute path the user chose. */
    chosen: string;
    /** The absolute path of the project root. */
    projectRoot: string;
    /** Whether a project-relative path is already taken, so a copy never overwrites one. */
    taken: (relativePath: string) => boolean;
    /** Path separator for the platform, so the result is a markup path rather than an OS one. */
    separator?: string;
}): AssetImport {
    const separator = options.separator ?? '/';
    const normalise = (value: string) => value.split(/[\\/]+/).filter((part) => part !== '');

    const rootParts = normalise(options.projectRoot);
    const chosenParts = normalise(options.chosen);

    // Same drive and the project's own path as a prefix: the file is already in the project.
    let shared = 0;
    while (shared < rootParts.length && shared < chosenParts.length && rootParts[shared] === chosenParts[shared]) {
        shared += 1;
    }
    if (shared === rootParts.length && chosenParts.length > rootParts.length) {
        return { relativePath: chosenParts.slice(rootParts.length).join(separator) };
    }

    // Outside: it comes in under assets/, keeping its name, and gains a suffix rather than replacing anything.
    const base = chosenParts[chosenParts.length - 1] ?? 'asset';
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const extension = dot > 0 ? base.slice(dot) : '';

    let name = base;
    for (let n = 2; options.taken(`${ASSET_DIRECTORY}/${name}`); n += 1) {
        name = `${stem}-${n}${extension}`;
    }
    return { relativePath: `${ASSET_DIRECTORY}/${name}`, copyFrom: options.chosen };
}
