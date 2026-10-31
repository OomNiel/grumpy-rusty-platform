/**
 * The one place that knows a project is written in Rust or in Arduino (C++).
 *
 * Everything in the extension that is not about a language -- the commands, the views, the chat, the panes,
 * the packaging, the Designer's canvas -- must not branch on the language, and this interface is how it
 * avoids having to. The five places that genuinely differ ask a `SketchBackend` instead:
 *
 *   1. the wizard (which templates a board offers, what preselects, what files a project is born with);
 *   2. the generator (`files`, the same answer, called by the wizard);
 *   3. the Designer's emit step (`handlersPath`, `panelPath`, and in phase 4 the emitters themselves);
 *   4. build/upload/monitor (`availableBackends` decides what the commands may offer);
 *   5. the AI's prompts and answer guards (a per-language twin of `ai/rustCode.ts`).
 *
 * Phase 1 of `plans/arduino-backend.md` puts today's Rust code behind this interface with **no behaviour
 * change**: `BACKENDS` holds one entry, so the wizard asks no language question and every generated file is
 * byte-identical to before. Phase 2 adds `arduinoBackend` and nothing else has to move.
 */

import { BoardProfile } from '../boards/types';
import { DESIGNER_HANDLERS_PATH } from '../designer/model';
import {
    DEFAULT_LANGUAGE,
    LANGUAGE_MARKER,
    SketchLanguage,
    languageMarker,
} from '../project/language';
import {
    AppTemplate,
    AppTemplateInfo,
    GenerateOptions,
    GeneratedFile,
    RP_PANEL_PATH,
    defaultTemplateFor,
    generateProjectFiles,
    templatesOfferedFor,
} from './files';

export interface SketchBackend {
    /** The language this backend writes. Unique across `BACKENDS`. */
    readonly id: SketchLanguage;
    /** How the wizard names the choice. A one-backend build never shows it, but the name is not invented later. */
    readonly label: string;
    /** One line under the label: what choosing it means. */
    readonly detail: string;
    /**
     * The file at the project root whose presence makes a folder a project of this language.
     *
     * This is the "is it real?" test: `src/project/activeProject.ts` reads a folder as a project of ours only
     * when this file is there, and reads the board out of it.
     */
    readonly markerFile: string;
    /** What the wizard offers for a board, and what it preselects. */
    templatesOfferedFor(board: BoardProfile): AppTemplateInfo[];
    defaultTemplateFor(board: BoardProfile): AppTemplate;
    /** Every file the project is born with. Pure: it never touches the filesystem. */
    files(options: GenerateOptions): GeneratedFile[];
    /** Where the Designer appends an event's stub. */
    handlersPath(): string;
    /** The file the Designer rewrites when the wiring changes. */
    panelPath(): string;
}

/**
 * Rust, as the extension has always generated it.
 *
 * Every member is a delegation: the generator, the template lists and the Designer's paths stay exactly where
 * they are, so this is a name for the way in rather than a second copy of the code.
 */
export const rustBackend: SketchBackend = {
    id: 'rust',
    label: 'Rust (Embassy)',
    detail: 'embassy-rp or esp-hal, embedded-gui for the screen, defmt logs. Probed and flashed with probe-rs.',
    markerFile: 'Cargo.toml',
    templatesOfferedFor,
    defaultTemplateFor,
    files: generateProjectFiles,
    handlersPath: () => DESIGNER_HANDLERS_PATH,
    panelPath: () => RP_PANEL_PATH,
};

/**
 * The backends this build can generate.
 *
 * One entry until phase 2. This list is what the wizard asks from and what the language step is skipped on,
 * so registering a backend is the whole of "the new language is available".
 */
export const BACKENDS: readonly SketchBackend[] = [rustBackend];

/** The languages the wizard can offer, in the order it offers them. */
export function availableBackends(): readonly SketchBackend[] {
    return BACKENDS;
}

/**
 * The backend for a language the caller knows is available.
 *
 * Throws for a language this build cannot generate -- that is a bug at the call site, not a user's mistake.
 * Code that has only read a language off a project's marker wants `backendOrDefault`, which cannot throw.
 */
export function backendFor(language: SketchLanguage): SketchBackend {
    const found = BACKENDS.find((backend) => backend.id === language);
    if (found === undefined) {
        throw new Error(
            `No ${language} backend in this build; available: ${BACKENDS.map((b) => b.id).join(', ')}.`,
        );
    }
    return found;
}

/**
 * The backend to read a project with.
 *
 * A project that says nothing is Rust, and so is one whose language this build cannot generate yet: the
 * folder is then still read, with the marker Rust expects, and simply does not look like a project. That is a
 * project that stays invisible rather than a command that falls over.
 */
export function backendOrDefault(language: SketchLanguage | undefined): SketchBackend {
    const wanted = language ?? DEFAULT_LANGUAGE;
    return BACKENDS.find((backend) => backend.id === wanted) ?? rustBackend;
}

/**
 * The files a project is born with, plus the marker that records its language.
 *
 * The marker is only written when the language is not the default: Rust needs no file to say it is Rust, and
 * writing one into every generated project would change every file list and every golden for no gain. What
 * a project with no marker means is decided once, in `readProjectLanguage`.
 */
export function projectFiles(backend: SketchBackend, options: GenerateOptions): GeneratedFile[] {
    const files = backend.files(options);
    if (backend.id === DEFAULT_LANGUAGE) {
        return files;
    }
    return [...files, { path: LANGUAGE_MARKER, content: languageMarker(backend.id) }];
}
