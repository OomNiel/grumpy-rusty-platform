/**
 * The build-driven repair loop.
 *
 * A rule-based checker can never be a compiler, so the strategy is the other way round: **the build is the
 * oracle and the rules are the hands**. Every pass runs the project's build, takes the first error that a
 * fixer understands, fixes it, and rebuilds — one error at a time, because every edit shifts line numbers
 * and can expose or erase the next error. It keeps going while it makes progress, and when it cannot fix
 * something it **skips** that error and tries the next, then hands the rest to the user as a list.
 *
 * Asked for on 2026-09-17, in these words: *"The system must check for errors by running a build when it is
 * done refactoring the code, then Code Fix must check for compile errors and fix each one, one at a time
 * untill the build is clean"* … *"Keep fixing what it can and list the rest."*
 *
 * Deliberately free of `vscode` and of any file access: everything that touches the project (building,
 * applying a fix, reverting, showing progress, cancelling) is injected. That is what makes the pass logic —
 * the progress guard, the revert and the termination rules — testable without a compiler or a window.
 */
import { CompilerDiagnostic } from './cargoMessages';

/** What the loop needs from its surroundings. */
export interface RepairContext {
    /** Builds the project and returns its diagnostics. Errors are what the loop repairs; warnings are only
     *  carried through, because they never stop a build and nothing here pretends to fix them. */
    build(): Promise<{ errors: CompilerDiagnostic[]; warnings?: CompilerDiagnostic[]; failure?: string }>;
    /**
     * Applies the fixer's understanding of ONE error. `fixed` = an edit was written (the loop then rebuilds
     * to see whether it helped), `no-fix` = nothing here knows how to repair it (the loop skips it and tries
     * the next error), `failed` = a fixer was found but the edit could not be applied.
     */
    fix(error: CompilerDiagnostic): Promise<'fixed' | 'no-fix' | 'failed'>;
    /** Puts the project back the way it was before the last `fix()` — used when a fix did not help. */
    revert(): Promise<void>;
    /** One line for the user, e.g. "Fixing CS1002 in MainWindow.axaml.cs (3 error(s) left)…". */
    progress(text: string): void;
    /** True when the user asked to stop (switched away, pressed Cancel, closed the panel). */
    cancelled(): boolean;
}

export interface RepairReport {
    /** Errors the first build reported. */
    started: number;
    /** Fixes that were kept because the rebuild showed the file got closer to compiling. */
    applied: number;
    /** Fixes that were undone because they did not help. */
    reverted: number;
    /** Errors that are gone — the useful summary. */
    fixed: CompilerDiagnostic[];
    /** Errors left when the loop stopped (what the user still has to do). */
    remaining: CompilerDiagnostic[];
    /** Warnings from the last build — reported, never fixed. */
    warnings: CompilerDiagnostic[];
    /** Builds run, including the final one. */
    builds: number;
    stoppedBecause: 'clean' | 'nothing-fixable' | 'no-progress' | 'cancelled' | 'max-passes' | 'build-failed';
    /** Set when a build could not run at all. */
    failure?: string;
}

/** The identity of an error: the same mistake reported at the same place with the same code. */
export function errorKey(d: CompilerDiagnostic): string {
    return `${d.file}:${d.line}:${d.column}:${d.code}`;
}

/** A one-line description used for progress and for the final summary. */
export function describeError(d: CompilerDiagnostic): string {
    const file = d.file.replace(/\\/g, '/').split('/').pop() ?? d.file;
    return `${d.code} in ${file}:${d.line}`;
}

/**
 * Runs the loop. Never throws: a build that cannot run is reported as `build-failed`, and a fixer that
 * throws is treated as `failed` (the loop moves on, which is what "keep fixing what it can" means).
 *
 * `maxPasses` bounds the *fix attempts* (each of which costs one build after it), so the worst case is
 * `maxPasses + 1` builds — a few seconds on an incremental build, and the only unbounded thing here would
 * be a fix that keeps trading one error for another.
 */
export async function repairUntilClean(ctx: RepairContext, maxPasses = 10): Promise<RepairReport> {
    const report: RepairReport = {
        started: 0, applied: 0, reverted: 0, fixed: [], remaining: [], warnings: [], builds: 0,
        // Overwritten by every way out that knows why it stopped; this is the one for "the budget ran out".
        stoppedBecause: 'max-passes'
    };
    const first = await ctx.build();
    report.builds += 1;
    report.warnings = first.warnings ?? [];
    if (first.failure) {
        report.stoppedBecause = 'build-failed';
        report.failure = first.failure;
        return report;
    }
    let errors = first.errors;
    report.started = errors.length;
    if (errors.length === 0) {
        report.stoppedBecause = 'clean';
        ctx.progress('The project builds — nothing to repair.');
        return report;
    }

    // Errors whose fixer has already had its go. An error that could not be fixed, or whose fix did not
    // help, is not retried for ever: it is "the rest" the user is told about at the end.
    const tried = new Set<string>();
    let budget = maxPasses;
    /** Fixes that were written — whether or not they helped. Tells "nothing was fixable" from "nothing helped". */
    let attempted = 0;

    while (budget > 0) {
        if (ctx.cancelled()) {
            report.stoppedBecause = 'cancelled';
            break;
        }
        const target = errors.find((e) => !tried.has(errorKey(e)));
        if (!target) {
            // Nothing left that any fixer is willing to try: either everything remaining is unfixable, or
            // fixes stopped helping. Say which, because they mean different things to the user.
            report.stoppedBecause = attempted === 0 ? 'nothing-fixable' : 'no-progress';
            break;
        }
        tried.add(errorKey(target));
        budget -= 1;
        const left = errors.length;
        ctx.progress(`Fixing ${describeError(target)} — ${left} error(s) left…`);

        let how: 'fixed' | 'no-fix' | 'failed';
        try { how = await ctx.fix(target); }
        catch { how = 'failed'; }
        if (how !== 'fixed') continue;                 // skip it, keep the rest of the list moving
        attempted += 1;

        const after = await ctx.build();
        report.builds += 1;
        report.warnings = after.warnings ?? report.warnings;
        if (after.failure) {
            report.stoppedBecause = 'build-failed';
            report.failure = after.failure;
            break;
        }
        const afterKeys = new Set(after.errors.map(errorKey));
        const gone = errors.filter((e) => !afterKeys.has(errorKey(e)));
        // Kept when the project moved closer to compiling: fewer errors, or the same count with at least
        // one old error gone (a fix can reveal a second mistake — that is progress, not noise).
        const helped = after.errors.length < errors.length
            || (after.errors.length === errors.length && gone.length > 0);
        if (helped) {
            report.applied += 1;
            report.fixed.push(...gone);
            errors = after.errors;
            if (errors.length === 0) {
                report.stoppedBecause = 'clean';
                break;
            }
        } else {
            await ctx.revert();
            report.reverted += 1;
        }
    }

    report.remaining = errors;
    return report;
}