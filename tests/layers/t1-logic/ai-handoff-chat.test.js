'use strict';

/**
 * A hand-off answer has to be *implementable*: a turn in the conversation, a button under it, a diff, and the
 * file untouched until that diff is applied.
 *
 * THE GAP THESE TESTS COME FROM (asked 2026-10-13): *"Can we equip it with the ability to generate diffs and on
 * permission implement it?"* A hand-off from the chat's refusal button did store its answer as a turn — but the
 * live message it posted carried **no code blocks**, so the "Implement …" buttons only appeared after the panel
 * was reloaded (the restored history computed them, the live post did not). Worse, a hand-off started from the
 * repair loop never entered the conversation at all: the answer was logged and shown in a notification, and the
 * only way to use its code was to select, copy and paste it by hand.
 *
 * The fix is in three places, and all three are asserted here because any one of them alone is invisible:
 * `handOff` announces its report once to registered listeners, the chat view turns that report into a normal
 * assistant turn carrying its code labels, and the notification offers the same diff-then-apply path a local
 * answer uses. These are source-level assertions — the view and the hand-off flow cannot be loaded by the suite
 * (both import `vscode`), which is the same reason `ai-panel-settings.test.js` reads the form's source.
 */
const fs = require('fs');
const path = require('path');
const { test, ok, contains } = require('../../lib/harness');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', ...parts), 'utf8');

test('every finished hand-off is announced, from one place', () => {
    const handoff = read('ai', 'handoff.ts');
    // Two different starting points end in the same conversation entry — the chat's refusal button and the repair
    // loop's last offer — so "put the answer in the conversation" is written once, here, not in both callers.
    ok(
        /const reportListeners: \(\(report: HandoffReport\) => void\)\[\] = \[\];/.test(handoff),
        'the report has listeners'
    );
    ok(/export function onHandoffReport\(/.test(handoff), 'and they can register');
    ok(
        /export async function handOff\(request: HandoffRequest\): Promise<HandoffReport> \{\n    const report = await performHandOff\(request\);/.test(handoff),
        'handOff is a wrapper...'
    );
    ok(/^async function performHandOff\(request: HandoffRequest\)/m.test(handoff), '...around the work itself');
    // A listener that throws must not lose the report the caller is waiting for.
    ok(
        /for \(const listener of reportListeners\) \{\n        try \{\n            listener\(report\);/.test(handoff),
        'and a broken listener cannot break the hand-off'
    );
});

test('a hand-off answer becomes a turn whose code can be implemented', () => {
    const view = read('ui', 'aiChatView.ts');
    ok(/function addHandoffTurn\(report: HandoffReport\)/.test(view), 'the view turns a report into a turn');
    ok(/onHandoffReport\(addHandoffTurn\)/.test(view), 'and registers that as the listener');
    // One label rule, used by the live turn and by the restored history: a reload cannot show a button that the
    // live turn hid, which is exactly how this was reported.
    ok(/function codeLabels\(role: string, text: string\): string\[\] \| undefined/.test(view), 'the label rule is one function');
    ok(
        /post\(\{ type: 'turn', role: 'assistant', text, final: true, index: chat\.turns\.length - 1, code: codeLabels\('assistant', text\) \}\)/.test(view),
        'the hand-off turn posts its code labels'
    );
    ok(/const code = codeLabels\(turn\.role, turn\.text\);\n        return code \?/.test(view), 'and the history computes them the same way');
    // A hand-off that was declined, switched off or could not start has nothing to implement, and the
    // conversation should not fill with "nothing was sent".
    ok(
        /if \(report\.kind !== 'answered' && report\.kind !== 'done'\) return;/.test(view),
        'a hand-off that wrote nothing is not a turn'
    );
    // The chat posts the turn itself for its own answers; the hand-off paths must not also do it, or every
    // hand-off would appear twice.
    ok(
        !/const report = await handOff\(/.test(view),
        'the chat no longer duplicates the report handling'
    );
});

test('the answered hand-off is offered as a diff, never as a file write', () => {
    const editor = read('ai', 'editor.ts');
    contains(editor, "'Review and implement…'", 'the notification offers the review');
    ok(
        /if \(pick === 'Review and implement…'\) await implementHandoffCode\(blocks\);/.test(editor),
        'and runs it when it is clicked'
    );
    ok(
        /const blocks = rustCodeBlocks\(report\.answer \|\| report\.full \|\| ''\);/.test(editor),
        'the blocks come from the answer the agent actually gave'
    );
    ok(
        /await applyChatCode\(chosen\.code, \{ label: codeBlockLabel\(chosen\.code\) \}\);/.test(editor),
        'through the same diff-then-apply path a local answer uses'
    );
    // The path it reuses is the one that asks for permission: `applyChatCode` shows the diff (`showProposal`) and
    // a whole-file answer is confirmed by name before it replaces anything.
    contains(editor, 'await showProposal(target, proposed, title);', 'which is the diff the user applies');
    // A hand-off whose answer carries several blocks asks which one, with the labels the chat shows.
    ok(/async function pickCodeBlock\(blocks: readonly CodeBlock\[\]\)/.test(editor), 'several blocks are offered as a choice');
    // The step log is what makes a notification's 160 characters traceable in the output channel.
    contains(editor, 'for (const step of report.work) log(`handoff:   ${step}`);', 'and the steps are still logged');
});

test('a cloud hand-off is not capped at the local answer budget', () => {
    // Asked 2026-10-13: *"Maximise the cloud agents must receive the full responses, do not cap it."* The cap is
    // dropped at the request itself (`ChatOptions.omitMaxTokens`, asserted behaviourally in `ai-assistant.test.js`);
    // what this pins is that the *hand-off* is the caller that asks for it, so a later refactor cannot quietly
    // put the local budget back on the cloud request.
    const handoff = read('ai', 'handoff.ts');
    ok(/omitMaxTokens: true/.test(handoff), 'the cloud hand-off asks for no answer cap');
    ok(
        /apiKey,\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*omitMaxTokens: true,/.test(handoff),
        'and it says why, next to the key that identifies the endpoint'
    );
});

test('the house rules are the rules a cloud agent gets', () => {
    // Asked 2026-10-13: *"how to set up the rules for the cloud agents?"* The answer is the house rules
    // (`rustyPlatform.assistant.conventions`, accepted with `Learn the House Rules from My Code…`) — and for an
    // endpoint there is nowhere else they could come from, because it never sees the project and cannot read a
    // rules file. They were missing from the facts block the chat builds, so the setting's own description
    // ("They are put in every prompt") was true of the editor flows and the repair hand-off, and false here.
    const view = read('ui', 'aiChatView.ts');
    ok(/parts\.push\(houseRules\(\)\);/.test(view), 'the facts block carries the house rules');
    ok(
        /function houseRules\(\): string \{\n    return conventionsBlock\(normaliseConventions\(configView\('rustyPlatform\.assistant'\)\.get\('conventions'\)\)\);/.test(view),
        'which are exactly the accepted conventions'
    );
    ok(/facts: await projectFacts\(\)/.test(view), 'so every hand-off from the chat carries them');
    ok(/\[await projectFacts\(\), fileBlock\(\)\]/.test(view), 'and so does the local prompt, from the same block');
});
