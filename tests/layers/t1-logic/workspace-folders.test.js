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

const { samePath } = compiled('project/workspaceFolders');

test('the same folder spelled two ways is recognised as the same folder', () => {
    // The two spellings that actually meet here: VS Code's `Uri.fsPath` and a path the wizard joined itself.
    ok(samePath('/home/me/proj', '/home/me/proj'), 'the plain case');
    ok(samePath('/home/me/proj/', '/home/me/proj'), 'a trailing separator is not a difference');
    ok(samePath('/home/me/proj/./', '/home/me/proj'), 'nor is a `.` segment');
    ok(samePath('/home/me/proj/blinky/../', '/home/me/proj'), 'and `..` is resolved before comparing');
    // Both separators, because a Windows path and a designer asset path can meet in one process.
    ok(samePath('C:\\Users\\me\\proj', 'C:/Users/me/proj'), 'and the two spellings of a Windows path agree');
    ok(samePath('C:\\Users\\me\\proj\\', 'C:\\Users\\me\\proj'), 'including a trailing backslash');

    // A string prefix would get all of these wrong, which is why the comparison is by segments.
    notOk(samePath('/home/ab', '/home/abc'), 'a sibling whose name merely starts the same');
    notOk(samePath('/home/me/proj', '/home/me/proj/blinky'), 'a child is not the same folder');
    notOk(samePath('/home/me/proj', '/home/me'), 'nor is a parent');
    notOk(samePath('C:\\Users\\me', 'D:\\Users\\me'), 'a different drive is a different place');
    notOk(samePath('/home/me/proj', '/home/me/projx'), 'and a longer name is a different folder');
});

// ---------------------------------------------------------------- the command

test('creating a project opens it as a folder, and not as a workspace', () => {
    // Source-level, like the other command tests: loading the folder has to happen as part of creating the
    // project and not only when a notification button is pressed -- "Later" and "Build Now" used to leave it
    // unloaded too, and the Designer's own button opened a canvas over a folder the window did not show.
    const source = fs.readFileSync(path.join(repoRoot(), 'src/commands/newProject.ts'), 'utf8');
    ok(source.includes('openProjectFolder(target)'), 'the new project becomes the window\'s folder');
    ok(
        source.indexOf('openProjectFolder(target)') > source.indexOf('showInformationMessage'),
        'after the prompt, so the answer can be acted on in this session',
    );
    ok(!/\n\s*if \(action === 'Open Designer'\)/.test(source), 'and not only for the Designer');

    // `openFolder` and not `updateWorkspaceFolders`. The latter was the first version of this fix, and adding a
    // folder to a window that has none produces an *untitled workspace* rather than a folder -- which VS Code
    // then wants saved as a `.code-workspace` file, so a generated project arrived as a workspace and stayed one.
    ok(source.includes("executeCommand('vscode.openFolder'"), 'it is opened as a plain folder');
    notOk(
        /vscode\.workspace\.updateWorkspaceFolders\s*\(/.test(source),
        'and never added as a second root of a workspace',
    );
    ok(source.includes('samePath'), 'with the already-open case recognised before reloading for nothing');
    // The designer keeps its explicit target: the folder it draws is the one just written.
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
        source.indexOf('requestDesignerAfterReload') < source.indexOf('openProjectFolder(target)'),
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
