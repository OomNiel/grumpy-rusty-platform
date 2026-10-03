/**
 * Project naming rules, shared by the RP and ESP generators.
 *
 * These live in their own module so `esp.ts` can use them without importing
 * `files.ts` at runtime -- `files.ts` imports the ESP generator, and a real cycle
 * between the two would be resolved at different times depending on which module
 * was loaded first. `files.ts` re-exports everything here, so callers and tests
 * that import from `files.ts` keep working unchanged.
 */

/** Cargo package name: lowercase, `-`-separated, `[a-z0-9_-]`, must start with a letter. */
export function crateNameFrom(projectName: string): string {
    const normalised = projectName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');
    if (normalised === '') {
        return 'firmware';
    }
    return /^[a-z]/.test(normalised) ? normalised : `fw-${normalised}`;
}

/**
 * The on-disk binary name Cargo produces for the default bin target.
 *
 * Cargo uses the package name **verbatim**: hyphens are NOT converted to
 * underscores. Verified against cargo 1.99 by the t4-e2e layer, which asserts
 * this exact artefact name — do not "fix" it to the underscore form.
 */
export function binaryNameFrom(projectName: string): string {
    return crateNameFrom(projectName);
}

export function isAcceptableProjectName(projectName: string): true | string {
    const trimmed = projectName.trim();
    if (trimmed === '') {
        return 'Enter a project name.';
    }
    if (/[\\/:*?"<>|]/.test(trimmed)) {
        return 'Project name cannot contain \\ / : * ? " < > |';
    }
    if (trimmed === '.' || trimmed === '..') {
        return 'Invalid project name.';
    }
    return true;
}
