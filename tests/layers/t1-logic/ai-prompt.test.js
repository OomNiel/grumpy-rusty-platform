'use strict';

/**
 * The prompt is written in the editor, at the caret, between two comment markers.
 *
 * The marker block is inserted into a file the user owns, so the property that matters most is that
 * removing it leaves the file exactly as it was — a prompt must never quietly remain as a comment in
 * someone's source. The parser also has to tell "no block" apart from "the block lost its closing marker",
 * because those are different things for the user to fix.
 */

const { test, ok, notOk, equal, contains, runtimeSkip } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { findPromptBlock, stripPromptBlock, hasPromptBlock, promptSnippet, commentPrefix, PROMPT_BEGIN, PROMPT_END } =
    compiled('ai/prompt');

test('findPromptBlock reads a block and strips the comment prefix from the prompt', () => {
    const text = `fn a() {}\n// ${PROMPT_BEGIN}\n// do the thing\n// ${PROMPT_END}\nfn b() {}\n`;
    const found = findPromptBlock(text);
    ok(found.ok, found.ok ? '' : found.why);
    equal(found.block.begin, 1);
    equal(found.block.end, 3);
    equal(found.block.prompt, 'do the thing');
});

test('a prose comment marker prefixed with a quote is stripped too', () => {
    const text = `// ${PROMPT_BEGIN}\n' buy milk\n// ${PROMPT_END}\n`;
    equal(findPromptBlock(text).block.prompt, 'buy milk');
});

test('a file with no begin marker says so', () => {
    const found = findPromptBlock('fn main() {}\n');
    equal(found.ok, false);
    contains(found.why, 'no ✎ AI block');
});

test('a block whose end marker was deleted is a different error', () => {
    const found = findPromptBlock(`// ${PROMPT_BEGIN}\n// hi\n`);
    equal(found.ok, false);
    contains(found.why, 'closing marker');
});

test('an empty block is reported as empty rather than as no prompt', () => {
    const found = findPromptBlock(`// ${PROMPT_BEGIN}\n// ${PROMPT_END}\n`);
    equal(found.ok, false);
    contains(found.why, 'empty');
});

test('stripPromptBlock leaves the file byte-identical', () => {
    const original = 'fn a() {}\nfn b() {}\n';
    const inserted = `fn a() {}\n// ${PROMPT_BEGIN}\n// do the thing\n// ${PROMPT_END}\nfn b() {}\n`;
    const found = findPromptBlock(inserted);
    equal(stripPromptBlock(inserted, found.block), original);
});

test('stripPromptBlock leaves a CRLF file byte-identical', () => {
    const original = 'fn a() {}\r\nfn b() {}\r\n';
    const inserted = `fn a() {}\r\n// ${PROMPT_BEGIN}\r\n// do it\r\n// ${PROMPT_END}\r\nfn b() {}\r\n`;
    const found = findPromptBlock(inserted);
    equal(stripPromptBlock(inserted, found.block), original);
});

test('the snippet carries both markers and puts the caret between them', () => {
    equal(promptSnippet('rust'), `// ${PROMPT_BEGIN}\n$0\n// ${PROMPT_END}\n`);
    contains(promptSnippet('rust'), '$0');
});

test('hasPromptBlock is the cheap marker check', () => {
    ok(hasPromptBlock(`// ${PROMPT_BEGIN}\n`));
    ok(hasPromptBlock(`// ${PROMPT_END}\n`));
    notOk(hasPromptBlock('fn main() {}\n'));
});

test('the comment prefix is Rust line comments, whatever language is asked for', () => {
    equal(commentPrefix('rust'), '//');
    equal(commentPrefix('csharp'), '//');
});
