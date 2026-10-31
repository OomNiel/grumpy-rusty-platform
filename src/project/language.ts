/**
 * Which language a project's sketch is written in.
 *
 * The extension is Rust today and is gaining an Arduino (C++) backend (`plans/arduino-backend.md`), so a
 * project has to be able to say which one it is. It says so in one small file at its root, and the rule for a
 * project that says nothing is the important part: **no marker means Rust**, because every project that
 * exists on disk today has no marker. That is what keeps this change from needing a migration at all.
 *
 * This module only reads and writes the marker. What a language *means* -- which templates it offers, which
 * files it generates, where the Designer writes -- is the backend's business; see `generate/backends.ts`.
 */

export type SketchLanguage = 'rust' | 'arduino';

/** What a project is when it has no marker: what every project on disk is. */
export const DEFAULT_LANGUAGE: SketchLanguage = 'rust';

/** The file that records the language, relative to the project root. */
export const LANGUAGE_MARKER = 'rusty.project.json';

/**
 * Every language the extension knows the *name* of.
 *
 * Deliberately wider than what can be generated: `availableBackends()` answers that, and the two differ
 * until a backend is registered. Keeping the names here is what lets a marker written by a newer build be
 * read as a language rather than as damage.
 */
export const SKETCH_LANGUAGES: readonly SketchLanguage[] = ['rust', 'arduino'];

export function isSketchLanguage(value: unknown): value is SketchLanguage {
    return typeof value === 'string' && (SKETCH_LANGUAGES as readonly string[]).includes(value);
}

/** The marker file's text, as it is written into a new project that has to say its language. */
export function languageMarker(language: SketchLanguage): string {
    return `${JSON.stringify({ language }, null, 2)}\n`;
}

/**
 * The language a project's marker records.
 *
 * Missing, empty, malformed or unrecognised text reads as Rust rather than as an error. A marker nobody can
 * parse must not make a working project invisible, and Rust is what such a project almost certainly is --
 * there is no project on disk whose marker says anything else yet.
 */
export function readProjectLanguage(markerText: string | undefined): SketchLanguage {
    if (markerText === undefined || markerText.trim() === '') {
        return DEFAULT_LANGUAGE;
    }
    try {
        const parsed = JSON.parse(markerText) as { language?: unknown } | null;
        const language = parsed === null ? undefined : parsed.language;
        return isSketchLanguage(language) ? language : DEFAULT_LANGUAGE;
    } catch {
        return DEFAULT_LANGUAGE;
    }
}

/**
 * Whether a folder is a Designer project.
 *
 * Two markers, because the two languages are born differently. A crate is a Designer project when it has the
 * design document (the wizard writes it for the `designer` template and for no other). A sketch cannot rely on
 * that alone: the C++ designer arrived later, so a project made before it has no `designer/` folder yet while
 * its `src/ui.cpp` -- which only the designer template writes -- is there. Offering the canvas for such a
 * project is what lets it be opened and saved into the document format, instead of looking like a project that
 * has no design.
 */
export function isDesignerProject(markers: {
    documentPresent: boolean;
    language: SketchLanguage;
    hasCppScreen: boolean;
}): boolean {
    return markers.documentPresent || (markers.language === 'arduino' && markers.hasCppScreen);
}
