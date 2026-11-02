'use strict';

/**
 * What the assist says, and which answers it offers back, per language.
 *
 * The AI half of the extension was written for Rust and said so in the system prompt, in the code-block guard and
 * in the project facts. A C++ project has none of those things, and an assistant told it is looking at Rust gives
 * confident answers about the wrong language -- which is the expensive kind of wrong, because the code looks
 * plausible. These cases pin the three seams that matter: which language is detected, what the model is told, and
 * which fenced blocks may be offered for a sketch.
 */

const { test, ok, equal, contains, notContains, compiled } = require('../../lib/harness');
const {
    CPP_ASSIST_KEYWORDS,
    assistLanguageOfDocument,
    assistLanguageOfProject,
    chatSystemPrompt,
    codeFenceFor,
    cppAssistExamples,
    isCodeBlockFor,
    sketchBrief,
} = compiled('ai/assistLanguage');

test('a language is detected from the document and from the project', () => {
    equal(assistLanguageOfDocument('rust'), 'rust', 'a .rs file is Rust');
    equal(assistLanguageOfDocument('cpp'), 'cpp', 'a .cpp file is C++');
    equal(assistLanguageOfDocument('c'), 'cpp', 'and so is a .c file');
    equal(assistLanguageOfDocument('ino'), 'cpp', 'Arduino\'s own id included');
    equal(assistLanguageOfDocument('typescript'), undefined, 'anything else is not ours');
    // The project's marker: a sketch says `arduino`, and every project that says nothing is Rust.
    equal(assistLanguageOfProject('arduino'), 'cpp', 'the Arduino backend is C++');
    equal(assistLanguageOfProject('rust'), 'rust', 'and the Rust backend is Rust');
    equal(assistLanguageOfProject(undefined), 'rust', 'a project with no marker is Rust');
    equal(codeFenceFor('cpp'), 'cpp', 'the fence names C++');
    equal(codeFenceFor('rust'), 'rust', 'and Rust');
});

test('the model is told the language, the framework and the files it may touch', () => {
    const cpp = chatSystemPrompt('cpp');
    contains(cpp, 'C++ coding assistant', 'the language first');
    contains(cpp, 'LVGL 9', 'the framework');
    contains(cpp, '`src/ui.cpp` and `src/ui.h` are generated', 'and that the screen is generated');
    contains(cpp, '`src/ui_handlers.cpp`', 'where the person\'s code belongs');
    contains(cpp, 'Never invent a pin, a library or an API', 'the rule that applies to both');
    contains(cpp, 'return ONLY the item that changes', 'and the shape rule');
    notContains(cpp, 'Embassy', 'nothing about Rust in it');
    notContains(cpp, 'Cargo', 'and no crate list');

    const rust = chatSystemPrompt('rust');
    contains(rust, 'Rust coding assistant', 'the other half still says Rust');
    contains(rust, 'Embassy', 'with its framework');
    contains(rust, 'Never invent a crate, a pin or an API', 'and the same rule in its own words');
    notContains(rust, 'LVGL', 'nothing about the panel');
});

test('a sketch\'s brief says which files are generated, because that is what a model cannot guess', () => {
    const brief = sketchBrief({ board: 'Raspberry Pi Pico 2 W', kind: 'rp', designer: true });
    contains(brief, 'Arduino sketch for Raspberry Pi Pico 2 W', 'the board by name');
    contains(brief, 'RP2040/RP2350', 'and the silicon, which decides the RAM budget');
    contains(brief, 'rewritten on every save', 'the generated screen, said out loud');
    contains(brief, 'src/ui_handlers.cpp', 'and where their code goes');
    contains(brief, 'LVGL 9', 'the display library');
    // An ESP32 project's brief says so, and a project with no board still produces a usable sentence.
    contains(sketchBrief({ kind: 'esp' }), 'ESP32', 'the other family');
    contains(sketchBrief({}), 'an RP2040 or ESP32 board', 'and a brief with no facts is still a brief');
});

test('only code in the project\'s own language is offered for the file', () => {
    equal(isCodeBlockFor('cpp', { language: 'cpp' }), true, 'C++ in a sketch');
    equal(isCodeBlockFor('cpp', { language: 'ino' }), true, 'an .ino fence too');
    equal(isCodeBlockFor('cpp', { language: 'hpp' }), true, 'and a header');
    equal(isCodeBlockFor('cpp', { language: '' }), true, 'an unlabelled block counts, as it does for Rust');
    equal(isCodeBlockFor('cpp', { language: 'rust' }), false, 'a Rust block does not belong in a sketch');
    equal(isCodeBlockFor('cpp', { language: 'python' }), false, 'nor does anything else');
    equal(isCodeBlockFor('rust', { language: 'rust' }), true, 'Rust in a crate');
    equal(isCodeBlockFor('rust', { language: 'rs' }), true, 'and its short name');
    equal(isCodeBlockFor('rust', { language: 'cpp' }), false, 'a C++ block does not belong in a crate');
});

test('every //~ keyword a sketch offers answers with a compilable-looking example', () => {
    for (const keyword of CPP_ASSIST_KEYWORDS) {
        const answer = cppAssistExamples(keyword);
        contains(answer, '```cpp', `${keyword} answers in a C++ fence`);
        ok(answer.length > 120, `${keyword} has more than a sentence of code`);
        notContains(answer, 'No examples yet', `${keyword} is not a gap`);
    }
    // A keyword nobody wrote for is refused in words that say what does exist, rather than returning nothing.
    const unknown = cppAssistExamples('semicolon');
    contains(unknown, 'No examples yet', 'an unknown keyword says so');
    contains(unknown, 'struct', 'and names the ones that work');
    // The trigger is matched case-insensitively, because a person types `//~ Struct` as often as `//~ struct`.
    contains(cppAssistExamples('STRUCT'), '```cpp', 'the keyword is read case-insensitively');
});
