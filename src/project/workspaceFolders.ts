/**
 * Comparing the folder a project was written into against what the window has open.
 *
 * "New Project" ends by making the created folder the folder the window is working in, and the only question
 * that needs answering before doing that is whether it is *already* that folder -- in which case reloading the
 * window to open what is open would be a no-op with a price.
 *
 * The answer is a path comparison, which is the part worth testing: the same folder reaches this code spelled
 * two different ways (VS Code's `Uri.fsPath` and a path the wizard joined itself), on either separator, with or
 * without a trailing one.
 *
 * The `vscode` calls that do the opening stay in the command, because that is the only place they can be
 * exercised by a human clicking through the wizard.
 */

/**
 * True when two paths name the same folder.
 *
 * Comparison is by path *segments*, not by string equality, because `/home/me/proj/` and `/home/me/proj` -- and
 * `/home/me/proj/./` and, on Windows, the two spellings of a path -- are the same folder. Trailing separators are
 * ignored and `.`/`..` are resolved first. Case is left alone: a case-insensitive comparison would be right on
 * Windows and wrong on Linux, and being wrong here costs nothing more than a redundant reload.
 */
export function samePath(a: string, b: string): boolean {
    const left = parts(a);
    const right = parts(b);
    return left.length === right.length && left.every((part, index) => part === right[index]);
}

/**
 * The path as comparable segments.
 *
 * Both separators are split on rather than asking which platform this is: a drive letter is then just a segment
 * that has to match, and a UNC prefix becomes empty segments, which are dropped.
 */
function parts(value: string): string[] {
    const out: string[] = [];
    for (const part of value.split(/[\\/]+/)) {
        if (part === '' || part === '.') {
            continue;
        }
        if (part === '..') {
            out.pop();
            continue;
        }
        out.push(part);
    }
    return out;
}
