'use strict';

/**
 * Where a newly created project has to land so the IDE shows it.
 *
 * The bug this covers: the wizard wrote a Designer project's files and then opened the canvas, but the folder
 * never became part of the window -- no Explorer entry, no Source Control, no terminal in it. Whether the folder
 * still *needs* loading is a question about paths and which folders the window has open, which is the part worth
 * testing; the two `vscode` calls that do the loading are asserted by source, as the other command tests are.
 */

const fs = require('fs');
const path = require('path');
const { test, ok, notOk, equal, compiled, repoRoot } = require('../../lib/harness');

const { isInside, isAlreadyLoaded } = compiled('project/workspaceFolders');

// ---------------------------------------------------------------- nesting

test('a folder inside another is recognised, by segment rather than by string prefix', () => {
    ok(isInside('/home/me/projects', '/home/me/projects/blinky'), 'the plain case');
    ok(isInside('/home/me/projects', '/home/me/projects'), 'a folder contains itself');
    // The one a string prefix gets wrong: `/home/ab` is not a prefix of `/home/abc`, but `/home/abc` is not
    // inside `/home/ab` either -- and `startsWith` would say it is.
    notOk(isInside('/home/ab', '/home/abc'), 'a sibling whose name merely starts the same');
    notOk(isInside('/home/me/projects', '/home/me'), 'a parent is not inside its child');
    notOk(isInside('/home/me/projects', '/elsewhere/projects'), 'an unrelated branch');
});

test('the path pieces a real machine produces line up', () => {
    // Both separators, because a designer asset path and a Windows path can meet in one process.
    ok(isInside('C:\\Users\\me\\proj', 'C:\\Users\\me\\proj\\blinky'), 'a Windows path with its own separator');
    ok(isInside('C:/Users/me/proj', 'C:\\Users\\me\\proj\\blinky'), 'and the two spellings of it agree');
    ok(isInside('/home/me/proj/', '/home/me/proj/blinky/'), 'trailing separators do not matter');
    ok(isInside('/home/me/proj', '/home/me/proj/./blinky'), 'a `.` segment is not a difference');
    ok(isInside('/home/me/proj', '/home/me/proj/blinky/../blinky'), 'and a `..` is resolved before comparing');
    // A drive letter is just a segment that has to match.
    notOk(isInside('C:\\Users\\me', 'D:\\Users\\me\\proj'), 'a different drive is a different place');
});

// ---------------------------------------------------------------- the decision

test('a project already inside an open folder does not get added again', () => {
    // The wizard offers the open folders as places to put a project, so this is the common case -- and adding it
    // would leave the Explorer showing the same directory twice, once nested inside the other.
    ok(isAlreadyLoaded(['/home/me/proj'], '/home/me/proj/blinky'), 'made inside the open folder');
    ok(isAlreadyLoaded(['/home/me/proj'], '/home/me/proj'), 'or as the open folder itself');
    ok(
        isAlreadyLoaded(['/home/elsewhere', '/home/me/proj'], '/home/me/proj/blinky'),
        'any of the open folders counts, not just the first',
    );
    notOk(isAlreadyLoaded(['/home/me/proj'], '/home/me/other'), 'a project outside every open folder');
    notOk(isAlreadyLoaded([], '/home/me/proj'), 'and with nothing open at all, it always has to be loaded');
});

// ---------------------------------------------------------------- the command

test('creating a project loads it into the IDE, whatever the user clicks next', () => {
    // Source-level, like the other command tests: the loading has to happen as part of creating the project and
    // not only when a notification button is pressed -- "Later" and "Build Now" used to leave the folder
    // unloaded too, and the Designer's own button opened a canvas over a folder the window did not show.
    const source = fs.readFileSync(path.join(repoRoot(), 'src/commands/newProject.ts'), 'utf8');
    ok(source.includes('loadIntoIde(target)'), 'the new project is loaded');
    ok(
        source.indexOf('loadIntoIde(target)') > source.indexOf('showInformationMessage'),
        'after the prompt, so the answer can be acted on in this session',
    );
    ok(!/\n\s*if \(action === 'Open Designer'\)/.test(source), 'the folder is not loaded only for the Designer');
    ok(source.includes('updateWorkspaceFolders'), 'by adding it to this window');
    ok(
        source.includes("executeCommand('vscode.openFolder'"),
        'with a reload kept as the fallback for a host that will not take it',
    );
    // The designer keeps its explicit target: the folder it draws is the one just written, whether or not it
    // has become a workspace folder yet.
    ok(source.includes('showDesigner(context, output, target)'), 'the designer is still pointed at the folder');
});

test('a Designer asked for before a reload is opened after it', () => {
    // The VS Code API says loading a folder may *restart the extension host* -- for the first folder added and
    // for the change from one folder to several, which is most of how this wizard is used. A webview cannot
    // survive that, so the request has to, and the order in the command is what makes it work: the request is
    // recorded before the folder is loaded, and cancelled only once the panel is open in a session that lived.
    const source = fs.readFileSync(path.join(repoRoot(), 'src/commands/newProject.ts'), 'utf8');
    ok(source.includes('requestDesignerAfterReload(context, target.fsPath)'), 'the request is recorded');
    ok(
        source.indexOf('requestDesignerAfterReload') < source.indexOf('loadIntoIde(target)'),
        'before the folder is loaded, since that is what may kill this session',
    );
    ok(
        source.indexOf('await forgetPendingDesigner(context)') >
            source.indexOf('showDesigner(context, output, target)'),
        'and cancelled only once this session has opened the panel itself',
    );

    // The other side of the reload: activation has to look for the request.
    const extension = fs.readFileSync(path.join(repoRoot(), 'src/extension.ts'), 'utf8');
    ok(extension.includes('resumePendingDesigner(context, output)'), 'activation resumes what was asked for');
    ok(
        extension.indexOf('resumePendingDesigner(context, output);') >
            extension.indexOf('context.subscriptions.push'),
        'after the rest of the wiring, so the panel opens into a working window',
    );

    // And a request that cannot be honoured has to be consumed rather than left to fire later on.
    const pending = fs.readFileSync(path.join(repoRoot(), 'src/designer/pendingOpen.ts'), 'utf8');
    ok(pending.includes('forgetPendingDesigner(context)'), 'a request is consumed as it is read');
    ok(pending.includes('existsSync'), 'a project that is gone is not opened');
    ok(pending.includes('VALID_FOR_MS'), 'and a stale request expires instead of surprising anyone');
});
