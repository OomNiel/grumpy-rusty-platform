/**
 * The crates a Designer project builds its shapes with, and whether the copy it holds is this extension's.
 *
 * A Designer project does not depend on `rusty-gui-widgets` or the `embedded-gui-codegen` fork from crates.io:
 * the wizard copies both into the project's `codegen/` folder, where the generated `Cargo.toml` points, so a
 * project builds offline and stays a folder you can hand to someone else. The cost of that is *staleness*: a
 * project created by one version keeps that version's crates, and the next version's designer can write markup
 * those crates do not understand.
 *
 * That is not hypothetical. A triangle's six vertex offsets (`p1x`..`p3y`) only exist in the fork from
 * 0.0.66 on; an older fork reads the three attributes it knows, ignores the six it does not, and paints the
 * isosceles triangle it always did -- a build that succeeds while the canvas shows a different shape. So the
 * version that copied the crates is recorded beside them, and the designer offers to refresh a copy that is not
 * its own. `absent` is the ordinary case for a project that is not a Designer project: nothing to update.
 *
 * The decision is a pure function of "is there a `codegen/` folder, what does the marker say, and which version
 * am I", and the copying is a copy of two directories: both are testable as plain code, which is why this module
 * only *types* against `vscode` and never calls into it. The one thing that has to ask the user lives in
 * `editor.ts`, beside the panel it is opening.
 */

import * as fs from 'fs';
import * as path from 'path';
// Type-only, deliberately: nothing here calls into `vscode`, so the decisions can be loaded and tested as plain
// code. The one thing that asks the user -- `ensureVendoredCrates` -- lives in `editor.ts`, which has a window.
import type * as vscode from 'vscode';

/**
 * The crates copied into a Designer project's `codegen/` folder, in the order they are written.
 *
 * `embedded-gui` is the runtime the generated code calls, vendored for the same reason as the other two: a few
 * values a design must be able to name -- a checkbox's box size, a gauge's tick and needle colours, the colours
 * inside a spinbox -- are read by the runtime's renderers, where no markup can reach them unless the runtime
 * itself is ours. See `crates/embedded-gui/README.md`.
 */
export const VENDORED_CRATES = ['rusty-gui-widgets', 'embedded-gui-codegen', 'embedded-gui'] as const;

/** Where in the project the copying extension's version is recorded. */
export const VENDORED_MARKER = 'codegen/.rusty-platform-crates';

/** The folder inside the extension that holds the crates to copy. */
export const VENDORED_SOURCE = 'crates';

export type VendoredState = 'absent' | 'unmarked' | 'stale' | 'current';

/**
 * What this project's vendored crates are, relative to the running extension.
 *
 * `absent` means there is no `codegen/` folder at all, which is how every non-Designer project looks: there is
 * nothing to be stale about. `unmarked` is a `codegen/` folder with no marker -- one copied before the marker
 * existed, or assembled by hand -- and is treated as needing an update for the same reason a marked older one
 * is: its contents cannot be shown to match this extension.
 */
export function vendoredState(options: {
    hasCrates: boolean;
    marker?: string;
    version: string;
}): VendoredState {
    if (!options.hasCrates) {
        return 'absent';
    }
    const marker = options.marker?.trim();
    if (marker === undefined || marker === '') {
        return 'unmarked';
    }
    return marker === options.version ? 'current' : 'stale';
}

/** Whether the copy should be replaced: everything but the two cases that are nothing to do with us. */
export function vendoredUpdateNeeded(state: VendoredState): boolean {
    return state === 'unmarked' || state === 'stale';
}

/** One line for the output channel and the prompt, saying what was found. */
export function vendoredDescription(state: VendoredState, marker: string | undefined): string {
    switch (state) {
        case 'current':
            return 'the project\'s vendored crates are this extension\'s';
        case 'stale':
            return `the project's vendored crates came from Rusty Platform ${marker}, not this extension`;
        case 'unmarked':
            return 'the project\'s vendored crates were copied before this extension recorded which version they came from';
        default:
            return 'the project vendors no crates of ours';
    }
}

/** Whether the project has a `codegen/` folder with both crates in it. */
export function hasVendoredCrates(project: vscode.Uri): boolean {
    return VENDORED_CRATES.every((crate) =>
        fs.existsSync(path.join(project.fsPath, 'codegen', crate, 'Cargo.toml')),
    );
}

/** The version recorded beside the crates, or `undefined` when nothing is recorded. */
export function readVendoredMarker(project: vscode.Uri): string | undefined {
    try {
        return fs.readFileSync(path.join(project.fsPath, VENDORED_MARKER), 'utf8');
    } catch {
        return undefined;
    }
}

/**
 * Copies both crates into the project's `codegen/` folder and records which version they came from.
 *
 * Each crate is removed before it is copied, so a file that the new version no longer has cannot linger and
 * keep compiling. The marker is written last: a half-finished copy therefore reads as unmarked, which is an
 * update waiting to happen rather than a copy that claims to be current.
 */
export function copyVendoredCrates(
    context: vscode.ExtensionContext,
    project: vscode.Uri,
    output: vscode.OutputChannel,
): void {
    const version = String(context.extension.packageJSON.version ?? '');
    const target = path.join(project.fsPath, 'codegen');
    fs.mkdirSync(target, { recursive: true });
    for (const crate of VENDORED_CRATES) {
        const from = path.join(context.extensionUri.fsPath, VENDORED_SOURCE, crate);
        const to = path.join(target, crate);
        output.appendLine(`copying ${crate} -> ${to}`);
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(from, to, { recursive: true });
    }
    fs.writeFileSync(path.join(target, '.rusty-platform-crates'), `${version}\n`, 'utf8');
    output.appendLine(`[designer] vendored crates updated (Rusty Platform ${version})`);
}
