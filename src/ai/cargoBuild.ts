/**
 * The project's own compiler, as the second half of the code check — running `cargo build` and publishing
 * what it said onto the lines it meant.
 *
 * The parsing lives in `cargoMessages.ts`, which imports no `vscode` and is therefore pinned by the t1
 * suite. This file is the part that needs an editor: the diagnostic collection, and the spawn.
 *
 * WHY THE BUILD IS `cargo check` BY DEFAULT. It produces exactly the same rustc diagnostics as
 * `cargo build`, several times faster, and the only thing it cannot catch is a link error — which is a
 * separate step the repair loop takes once the errors are gone. The user-facing "build the firmware" path
 * stays `cargo build` (`commands/projectCommands.ts`).
 *
 * THE BUILD RUNS ON DEMAND ONLY. A cold embedded build is minutes, not seconds, so this never runs while
 * typing and never on a save. It is called by the repair loop and by the "check the project" command, both
 * of which are explicit user actions.
 */
import * as vscode from 'vscode';
import { augmentedEnv, execFileFn, findExecutable, type ExecFn } from '../util/exec';
import {
    BUILD_TIMEOUT_MS,
    firstCargoError,
    parseCargoOutput,
    type BuildResult,
    type CompilerDiagnostic
} from './cargoMessages';

export {
    BUILD_TIMEOUT_MS,
    firstCargoError,
    isProjectSource,
    parseCargoMessages,
    parseCargoOutput,
    parseRustcText,
    resolveInProject
} from './cargoMessages';
export type { BuildResult, CompilerDiagnostic, ProjectError } from './cargoMessages';

export interface BuildOptions {
    /** Extra environment the project needs (Wi-Fi credentials, `DEFMT_LOG`, …). */
    env?: NodeJS.ProcessEnv;
    /** Override the executable (the extension's `cargoPath` setting, else auto-detection). */
    cargoPath?: string;
    /** `cargo build` or `cargo check` — check is much faster and catches everything except link errors. */
    mode?: 'build' | 'check';
    timeoutMs?: number;
    exec?: ExecFn;
}

/**
 * Runs the project's own build and returns what it said.
 *
 * rustc prints JSON to **stdout**; errors that happen before it starts (a broken manifest, a missing
 * target) go to stderr as plain text. Both are parsed, because both are the compiler talking.
 */
export async function buildProject(projectDir: string, options: BuildOptions = {}): Promise<BuildResult> {
    const exec = options.exec ?? execFileFn;
    const cargo = findExecutable('cargo', options.cargoPath);
    if (!cargo) {
        return {
            ok: false,
            diagnostics: [],
            projectErrors: [],
            errors: 0,
            warnings: 0,
            skipped: 0,
            failure: '`cargo` was not found — install the Rust toolchain (or set `rustyPlatform.cargoPath`) and try again.'
        };
    }
    const mode = options.mode ?? 'check';
    const args = [mode, '--message-format=json', '--quiet'];
    const result = await exec(cargo, args, {
        cwd: projectDir,
        env: { ...augmentedEnv(), ...(options.env ?? {}) },
        timeoutMs: options.timeoutMs ?? BUILD_TIMEOUT_MS
    });
    if (result.notFound) {
        return {
            ok: false,
            diagnostics: [],
            projectErrors: [],
            errors: 0,
            warnings: 0,
            skipped: 0,
            failure: '`cargo` could not be started — check `rustyPlatform.cargoPath`.'
        };
    }
    const combined = `${result.stdout}\n${result.stderr}`;
    const parsed = parseCargoOutput(combined, projectDir);
    const errors = parsed.diagnostics.filter((d) => d.severity === 'error').length + parsed.projectErrors.length;
    const warnings = parsed.diagnostics.filter((d) => d.severity === 'warning').length;
    const failure = result.code !== 0 && errors === 0
        ? firstCargoError(result.stderr) ?? `\`cargo ${mode}\` exited with code ${result.code}.`
        : undefined;
    return {
        ok: result.code === 0,
        diagnostics: parsed.diagnostics,
        projectErrors: parsed.projectErrors,
        errors,
        warnings,
        skipped: parsed.skipped,
        failure,
        stderr: result.stderr.trim().split(/\r?\n/).slice(-20).join('\n')
    };
}

/** A diagnostic as VS Code wants it: a range on the line and column the compiler named. */
export function compilerIssues(list: CompilerDiagnostic[]): { file: string; diagnostic: vscode.Diagnostic }[] {
    return list.map((d) => {
        const range = new vscode.Range(
            Math.max(0, d.line - 1),
            Math.max(0, d.column - 1),
            Math.max(0, d.line - 1),
            Math.max(0, d.column)
        );
        const diagnostic = new vscode.Diagnostic(
            range,
            d.code ? `${d.message} (${d.code})` : d.message,
            d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = 'cargo';
        if (d.code) diagnostic.code = d.code;
        return { file: d.file, diagnostic };
    });
}

let collection: vscode.DiagnosticCollection | undefined;

function diagnostics(): vscode.DiagnosticCollection {
    if (!collection) collection = vscode.languages.createDiagnosticCollection('Rusty AI');
    return collection;
}

/** Publishes a build's diagnostics so the errors sit on the lines the compiler meant. */
export function publishBuildDiagnostics(diagnosticsList: CompilerDiagnostic[]): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const item of compilerIssues(diagnosticsList)) {
        const key = vscode.Uri.file(item.file).toString();
        const bucket = byFile.get(key) ?? [];
        bucket.push(item.diagnostic);
        byFile.set(key, bucket);
    }
    const target = diagnostics();
    target.clear();
    for (const [key, list] of byFile) target.set(vscode.Uri.parse(key), list);
}

export function clearBuildDiagnostics(): void {
    diagnostics().clear();
}

export function disposeBuildDiagnostics(): void {
    collection?.dispose();
    collection = undefined;
}
