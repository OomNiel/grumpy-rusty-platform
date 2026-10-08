/**
 * Where a freshly created project has to land so the IDE actually shows it.
 *
 * Writing the files is only half of "create a project". A folder the window does not know about has no Explorer
 * entry, no Source Control, no terminal opened in it and no language service, so the extension created something
 * the user then has to go and open by hand -- which is not what "New Project" promises. The rule here is the
 * small piece of that decision that depends on paths rather than on the editor, so it can be tested: a project
 * is *already loaded* when it sits inside a folder the workspace has open, and needs loading when it does not.
 *
 * Keeping it separate from the `vscode` calls also keeps the interesting case -- one path being nested inside
 * another, on either separator, at any depth -- out of the parts of the command that can only be exercised by a
 * human clicking through the wizard.
 */

/**
 * True when `child` is `parent` itself or sits inside it.
 *
 * Comparison is by path *segments* rather than by string prefix, because a string prefix gets `/home/ab` and
 * `/home/abc` wrong -- and both separators are accepted, since a designer asset path and a Windows path can meet
 * in the same process. Trailing separators are ignored, and a relative `.` or `..` is resolved away first.
 */
export function isInside(parent: string, child: string): boolean {
    const parentParts = parts(parent);
    const childParts = parts(child);
    if (parentParts.length === 0 || parentParts.length > childParts.length) {
        return false;
    }
    return parentParts.every((part, index) => part === childParts[index]);
}

/**
 * True when the folder is already visible in the IDE, because some open folder contains it.
 *
 * A new project is very often made *inside* the folder that is already open -- the wizard offers the open
 * folders as the place to put it -- and adding it again would leave the Explorer showing the same directory
 * twice, once nested inside the other.
 */
export function isAlreadyLoaded(openFolders: readonly string[], target: string): boolean {
    return openFolders.some((folder) => isInside(folder, target));
}

/**
 * The path as comparable segments.
 *
 * `path.win32` and `path.posix` cannot both be right on one platform, so this splits on both separators instead
 * of asking which platform it is: a drive letter is just a segment that has to match, and a UNC prefix ends up
 * as empty segments that are dropped. Case is left alone -- a case-insensitive comparison would be right on
 * Windows and wrong on Linux, and being wrong in the direction of "add a folder that is already there" is a
 * cosmetic mistake rather than a lost project.
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
