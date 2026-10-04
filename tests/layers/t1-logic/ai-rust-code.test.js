'use strict';

/**
 * Reading Rust and putting a function back into it.
 *
 * This module is the language half of the assistant: it finds the item the caret is in, sends exactly that
 * function to the model, and splices the answer back without letting the model drop an attribute or change a
 * signature. It is the code most likely to corrupt a file it does not own, so the tests are built around the
 * shapes a real embassy `main.rs` has — attributes above the `fn`, braces inside strings and char literals, a
 * lifetime that looks like a quote, and a file with CRLF endings and a BOM.
 */

const { test, ok, equal, notOk, contains, notContains, runtimeSkip } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    itemSpans,
    enclosingItemSpan,
    enclosingFnSpan,
    enclosingContainerSpan,
    itemOffsets,
    insertItem,
    addItemToFile,
    spliceItem,
    preserveSignature,
    unwrapItem,
    parseNewItemAnswer,
    declarationRegion,
    alreadyImported,
    crateList,
    moduleHeader,
    detectEol,
    reindent,
    itemNameOf,
    sniffItemName,
    useBlockStart,
    stripTrivia,
    braceBlockEnd,
} = compiled('ai/rustCode');

/** A realistic embassy Pico project: attributes, an impl, a mod, and a main that spawns a task. */
const EMBASSY_MAIN = `#![no_std]
#![no_main]

use defmt::info;
use embassy_executor::Spawner;
use embassy_rp::gpio::{Level, Output};
use {defmt_rtt as _, panic_probe as _};

/// Blinks the on-board LED.
#[embassy_executor::task]
async fn blink_task(mut led: Output<'static>) {
    loop {
        led.set_high();
        embassy_time::Timer::after_millis(500).await;
        led.set_low();
        embassy_time::Timer::after_millis(500).await;
    }
}

struct Blinker {
    led: Output<'static>,
}

impl Blinker {
    fn new(led: Output<'static>) -> Self {
        Self { led }
    }

    async fn run(&mut self) {
        self.led.set_high();
    }
}

mod helpers {
    pub fn scale(value: u32) -> u32 {
        value * 2
    }
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let p = embassy_rp::init(Default::default());
    let led = Output::new(p.PIN_25, Level::Low);
    spawner.spawn(blink_task(led)).unwrap();
}
`;

/** Braces that are not braces, in every trivia form Rust has. */
const BRACE_TRIVIA = [
    'fn tricky() {',
    '    let a = "}";',
    "    let b = '}';",
    '    let c = r#"}"#;',
    '    let d = b"}";',
    '    /* } */',
    '    // }',
    "    let e: &'static str = \"x\";",
    '}',
    'fn after() {}',
].join('\n');

function spanNamed(text, name) {
    const span = itemSpans(text).find((candidate) => candidate.name === name);
    ok(span, `expected an item span named ${name}`);
    return span;
}

test('itemSpans finds every braced item with its exact span', () => {
    equal(
        itemSpans(EMBASSY_MAIN).map((s) => `${s.kind} ${s.name} ${s.declLine}-${s.endLine}`),
        [
            'fn blink_task 11-18',
            'impl Blinker 24-32',
            'fn new 25-27',
            'fn run 29-31',
            'mod helpers 34-38',
            'fn scale 35-37',
            'fn main 41-45',
        ],
    );
});

test('an item span starts on its declaration, never on the attributes above it', () => {
    const blink = spanNamed(EMBASSY_MAIN, 'blink_task');
    equal(blink.declLine, 11);
    equal(blink.declaration, "async fn blink_task(mut led: Output<'static>) {");
    notContains(blink.declaration, 'embassy_executor::task');
});

test('brace trivia inside strings, char literals, raw strings and comments is skipped', () => {
    equal(
        itemSpans(BRACE_TRIVIA).map((s) => `${s.name} ${s.declLine}-${s.endLine}`),
        ['tricky 1-9', 'after 10-10'],
    );
});

test('a lifetime is not mistaken for a char literal', () => {
    const src = "fn with_lifetime<'a>(x: &'a str) -> &'a str {\n    x\n}\nfn next() {}\n";
    equal(
        itemSpans(src).map((s) => `${s.name} ${s.declLine}-${s.endLine}`),
        ['with_lifetime 1-3', 'next 4-4'],
    );
    equal(stripTrivia("fn f<'a>(x: &'a str) {}"), 'fn f<a>(x: &a str) {}');
});

test('stripTrivia leaves only code behind', () => {
    equal(stripTrivia('let a = "}";'), 'let a = ;');
    equal(stripTrivia("let b = '}';"), 'let b = ;');
    equal(stripTrivia('let c = r#"}"#;'), 'let c = ;');
    equal(stripTrivia('let d = b"}";'), 'let d = ;');
    equal(stripTrivia('/* } */'), '');
    equal(stripTrivia('// }'), '');
});

test('a multi-line trait method is not a block', () => {
    const src = [
        'trait Codec {',
        '    fn decode(',
        '        &self,',
        '        input: &[u8],',
        '        output: &mut [u8],',
        '        scratch: &mut [u8],',
        '    ) -> usize;',
        '}',
        '',
        'fn after() {}',
    ].join('\n');
    equal(
        itemSpans(src).map((s) => `${s.kind} ${s.name}`),
        ['trait Codec', 'fn after'],
    );
});

test('a short trait method is not a block', () => {
    const src = [
        'trait Sensor {',
        '    fn read(&self) -> u8;',
        '}',
        '',
        'impl Sensor for Adc {',
        '    fn read(&self) -> u8 {',
        '        0',
        '    }',
        '}',
    ].join('\n');
    notOk(
        itemSpans(src).some((s) => s.kind === 'fn' && s.name === 'read' && s.declLine === 2),
        'the trait method must not be reported as a block',
    );
});

test('enclosingItemSpan and enclosingFnSpan find the innermost function', () => {
    equal(enclosingFnSpan(EMBASSY_MAIN, 14).name, 'blink_task');
    equal(enclosingFnSpan(EMBASSY_MAIN, 27).name, 'new');
    equal(enclosingFnSpan(EMBASSY_MAIN, 31).name, 'run');
    equal(enclosingFnSpan(EMBASSY_MAIN, 44).name, 'main');
    equal(enclosingFnSpan(EMBASSY_MAIN, 3), undefined);
    equal(enclosingItemSpan(EMBASSY_MAIN, 27).name, 'new');
});

test('the declaration line and the closing brace both count as inside an item', () => {
    equal(enclosingFnSpan(EMBASSY_MAIN, 11).name, 'blink_task');
    equal(enclosingFnSpan(EMBASSY_MAIN, 18).name, 'blink_task');
    equal(enclosingItemSpan(EMBASSY_MAIN, 24).kind, 'impl');
    equal(enclosingItemSpan(EMBASSY_MAIN, 32).kind, 'impl');
});

test('enclosingContainerSpan returns the impl or mod, not the method inside it', () => {
    const inImpl = enclosingContainerSpan(EMBASSY_MAIN, 27);
    equal(inImpl.name, 'Blinker');
    equal(inImpl.kind, 'impl');
    const inMod = enclosingContainerSpan(EMBASSY_MAIN, 36);
    equal(inMod.name, 'helpers');
    equal(inMod.kind, 'mod');
    equal(enclosingContainerSpan(EMBASSY_MAIN, 44), undefined);
});

test('itemOffsets slice exactly the item text', () => {
    const span = enclosingFnSpan(EMBASSY_MAIN, 30);
    const { start, end } = itemOffsets(EMBASSY_MAIN, span);
    equal(EMBASSY_MAIN.slice(start, end), '    async fn run(&mut self) {\n        self.led.set_high();\n    }');
});

test('spliceItem replaces the item and nothing else, keeping the BOM and the blank line', () => {
    const src =
        '\uFEFF// header\n\n#[embassy_executor::task]\nasync fn blink_task() {\n    a();\n}\n\nfn other() {\n    b();\n}\n';
    const out = spliceItem(src, spanNamed(src, 'blink_task'), 'async fn blink_task() {\n    c();\n}');
    equal(out.charCodeAt(0), 0xfeff, 'the BOM comes back');
    contains(out, '#[embassy_executor::task]\nasync fn blink_task()', 'the attribute above the fn survives');
    contains(out, 'c();');
    notContains(out, 'a();');
    contains(out, '}\n\nfn other() {\n    b();\n}', 'the blank line and the next function are intact');
});

test('spliceItem preserves CRLF line endings', () => {
    const src = '#[task]\r\nasync fn blink() {\r\n    a();\r\n}\r\n\r\nfn other() {\r\n}\r\n';
    const out = spliceItem(src, spanNamed(src, 'blink'), 'async fn blink() {\r\n    b();\r\n}\r\n');
    equal(out, '#[task]\r\nasync fn blink() {\r\n    b();\r\n}\r\n\r\nfn other() {\r\n}\r\n');
});

test('spliceItem re-indents a nested method to its original indentation', () => {
    const src = 'impl Foo {\n    fn a(&self) {\n        x();\n    }\n}\n';
    const out = spliceItem(src, spanNamed(src, 'a'), 'fn a(&self) {\n    y();\n}');
    equal(out, 'impl Foo {\n    fn a(&self) {\n        y();\n    }\n}\n');
});

test('preserveSignature restores the model-changed declaration and keeps the body', () => {
    const original = 'pub fn add(a: u32) -> u32 {\n    0\n}';
    const answer = 'fn add(a: i32) -> i32 {\n    a + 1\n}';
    const fixed = preserveSignature(original, answer);
    contains(fixed.item, 'pub fn add(a: u32) -> u32 {');
    contains(fixed.item, 'a + 1');
    notContains(fixed.item, 'i32');
    equal(fixed.changed.length, 1);
});

test('preserveSignature is a no-op when the declaration already matches', () => {
    const same = 'fn add(a: u32) -> u32 {\n    0\n}';
    const fixed = preserveSignature(same, same);
    equal(fixed.item, same);
    equal(fixed.changed, []);
});

test('preserveSignature survives a multi-line signature', () => {
    const original = 'pub async fn run(\n    &mut self,\n    led: Led,\n) -> Result<(), Error> {\n    Ok(())\n}';
    const answer = 'async fn run(&mut self, led: Led) -> Result<(), Error> {\n    Err(())\n}';
    const fixed = preserveSignature(original, answer);
    contains(fixed.item, 'pub async fn run(');
    contains(fixed.item, 'led: Led');
    contains(fixed.item, 'Err(())');
    notContains(fixed.item, 'Ok(())');
});

test('unwrapItem removes an impl or mod wrapper and keeps the first function', () => {
    const wrapped = 'impl Foo {\n    fn a(&self) {\n        1\n    }\n\n    fn b(&self) {}\n}';
    const result = unwrapItem(wrapped);
    equal(result.unwrapped, true);
    equal(result.count, 2);
    equal(result.names, ['a', 'b']);
    contains(result.item, 'fn a(&self) {');
    notContains(result.item, 'fn b');

    const modWrapped = unwrapItem('mod x {\n    fn a() {}\n}');
    equal(modWrapped.unwrapped, true);
    equal(modWrapped.names, ['a']);
    contains(modWrapped.item, 'fn a() {}');
});

test('unwrapItem leaves a bare function and a deliberately nested mod alone', () => {
    const bare = 'fn only() {}';
    equal(unwrapItem(bare).item, bare);
    equal(unwrapItem(bare).unwrapped, false);

    const nested = 'fn outer() {\n    mod inner {\n        fn x() {}\n    }\n}';
    equal(unwrapItem(nested).item, nested);
    equal(unwrapItem(nested).unwrapped, false);
});

test('unwrapItem reports an empty wrapper as no item', () => {
    const result = unwrapItem('impl Foo {\n}');
    equal(result.unwrapped, true);
    equal(result.item, '');
    equal(result.count, 0);
});

test('parseNewItemAnswer splits use lines before the new-item marker', () => {
    const parsed = parseNewItemAnswer('use a::B;\nuse c::D;\n--- new item ---\nfn f() {\n}');
    equal(parsed.uses, ['use a::B;', 'use c::D;']);
    equal(parsed.item, 'fn f() {\n}');
    equal(parsed.note, '');
});

test('parseNewItemAnswer works with no marker and with a commented marker', () => {
    const noMarker = parseNewItemAnswer('use a::B;\nfn f() {}');
    equal(noMarker.uses, ['use a::B;']);
    equal(noMarker.item, 'fn f() {}');

    const commented = parseNewItemAnswer('use a::B;\n// --- new item ---\nfn f() {}');
    equal(commented.uses, ['use a::B;']);
    equal(commented.item, 'fn f() {}');
});

test('addItemToFile hoists a new use above the first item and never duplicates one', () => {
    const src = '#![no_std]\nuse a::B;\n\nimpl Foo {\n    fn a(&self) {}\n\n    fn b(&self) {}\n}\n';
    const span = enclosingItemSpan(src, 6);
    const out = addItemToFile({
        text: src,
        caretLine: 6,
        item: 'fn c(&self) {}',
        span,
        uses: ['use core::fmt;', 'use a::B;'],
    });
    equal(out.added, ['use core::fmt;']);
    equal(out.text.split('use core::fmt;').length - 1, 1);
    equal(out.text.split('use a::B;').length - 1, 1, 'the duplicate is not added twice');
    contains(out.text, 'use a::B;\nuse core::fmt;\n');
    ok(out.text.indexOf('use core::fmt;') < out.text.indexOf('impl Foo {'));
});

test('a new use never lands before the crate attributes', () => {
    const src = '#![no_std]\n#![no_main]\n\nfn one() {}\n';
    const out = addItemToFile({ text: src, caretLine: 4, item: 'fn two() {}', span: undefined, uses: ['use core::fmt;'] });
    ok(out.text.indexOf('#![no_std]') < out.text.indexOf('use core::fmt;'), 'inner attributes must stay first');
});

test('insertItem lands below the caret, separated by one blank line', () => {
    const src = 'fn one() {\n    a();\n}\n\nfn two() {\n}\n';
    const out = insertItem({ text: src, caretLine: 4, item: 'fn three() {}', span: undefined });
    equal(out, 'fn one() {\n    a();\n}\n\nfn three() {}\n\nfn two() {\n}\n');
});

test('insertItem stays inside the parent, never before the opening brace or after the closing one', () => {
    const src = 'impl Foo {\n    fn a(&self) {}\n\n    fn b(&self) {}\n}\n';
    const span = enclosingItemSpan(src, 1);
    const atTop = insertItem({ text: src, caretLine: 1, item: 'fn c(&self) {}', span });
    ok(atTop.indexOf('fn c(&self) {}') > atTop.indexOf('impl Foo {'));
    const atBottom = insertItem({ text: src, caretLine: 99, item: 'fn d(&self) {}', span });
    ok(atBottom.indexOf('fn d(&self) {}') < atBottom.lastIndexOf('}'));
});

test('insertItem indents a new item like its container neighbours', () => {
    const src = 'impl Foo {\n    fn a(&self) {}\n\n    fn b(&self) {}\n}\n';
    const span = enclosingItemSpan(src, 3);
    equal(span.kind, 'impl');
    const out = insertItem({ text: src, caretLine: 3, item: 'fn c(&self) {}', span });
    contains(out, '\n    fn c(&self) {}');
});

test('crateList returns the dependency tables and nothing else', () => {
    const toml = [
        '[package]',
        'name = "x"',
        '',
        '[dependencies]',
        'defmt = "1.1"',
        'embassy-time = { version = "0.5" }',
        '',
        '[dev-dependencies]',
        'serde = "1"',
        '',
        '[profile.release]',
        'lto = true',
        '',
    ].join('\n');
    const list = crateList(toml);
    equal(list, '[dependencies]\ndefmt = "1.1"\nembassy-time = { version = "0.5" }\n[dev-dependencies]\nserde = "1"');
    notContains(list, 'lto');
    notContains(list, 'name = "x"');
    notContains(crateList('[dependencies]\n# a comment\ndefmt = "1"'), '# a comment');
});

test('moduleHeader carries the crate attributes, the use lines and the enclosing impl', () => {
    const inImpl = moduleHeader(EMBASSY_MAIN, enclosingFnSpan(EMBASSY_MAIN, 27));
    contains(inImpl, '#![no_std]');
    contains(inImpl, 'use embassy_rp::gpio::{Level, Output};');
    contains(inImpl, 'impl Blinker {');

    const topLevel = moduleHeader(EMBASSY_MAIN, enclosingFnSpan(EMBASSY_MAIN, 44));
    contains(topLevel, '#![no_std]');
    notContains(topLevel, 'impl Blinker {');
    equal(moduleHeader('', undefined), '');
});

test('detectEol and reindent keep the shape of a file', () => {
    equal(detectEol('a\r\nb'), '\r\n');
    equal(detectEol('a\nb'), '\n');
    equal(reindent('    fn a() {\n        1\n    }', '', '\n'), 'fn a() {\n    1\n}');
    equal(reindent('fn a() {\n    1\n}', '    ', '\n'), '    fn a() {\n        1\n    }');
});

test('itemNameOf and sniffItemName', () => {
    equal(itemNameOf('async fn hello() {}'), 'hello');
    equal(itemNameOf('/// doc\nstruct X;'), undefined);
    equal(sniffItemName("Create a function named 'blink_task' that blinks"), 'blink_task');
    equal(sniffItemName('called readSensor occasionally'), 'readSensor');
    equal(sniffItemName('named ab'), undefined);
});

test('alreadyImported matches a use line modulo whitespace, and useBlockStart points past the header', () => {
    ok(alreadyImported('use core::fmt;\nuse a::B;', '  use   a::B;  '));
    notOk(alreadyImported('use core::fmt;', 'use a::B;'));
    equal(useBlockStart('#![no_std]\nuse a::B;\n\nfn x() {}'), 2);
    ok(declarationRegion('#[task]\npub async fn run(a: u8) -> u8 {\n    a\n}').text.includes('pub async fn run'));
    equal(braceBlockEnd(['fn f() {}'], 0), 0);
});

// ------------------------------------------------ code from the chat (asked 2026-10-04)

test('a whole file is told apart from one item — because one replaces and the other is placed', () => {
    const rc = compiled('ai/rustCode');
    // An inner attribute is illegal anywhere but the top of a file, so it settles the question on its own.
    ok(rc.looksLikeWholeFile('#![no_std]\n#![no_main]\n\nfn main() {}'));
    ok(rc.looksLikeWholeFile('#![no_std]\nuse embassy_executor::Spawner;\n\n#[embassy_executor::main]\nasync fn main(spawner: Spawner) {}'));
    // `use` beside `main` is a file too: a single function never needs to import anything.
    ok(rc.looksLikeWholeFile('use std::io;\n\nfn main() {\n    println!("hi");\n}'));
    // A *refactor of main* is not a file. It carries no `use` line, and treating it as one would replace
    // `main.rs` with a single function — deleting every other item in it. This is the case that made the rule:
    // it must be spliced in, where the file's own `#[embassy_executor::main]` is preserved by the signature fix.
    notOk(rc.looksLikeWholeFile('#[embassy_executor::main]\nasync fn main(spawner: Spawner) {}'));
    notOk(rc.looksLikeWholeFile('pub fn main() {}'));
    // Everything else is an item, and an item must not delete the file it lands in.
    notOk(rc.looksLikeWholeFile('fn flash_led(interval: u64) {\n    led.toggle();\n}'));
    notOk(rc.looksLikeWholeFile('impl Led {\n    fn set(&self) {}\n}'));
    notOk(rc.looksLikeWholeFile('struct Config {\n    interval: u64,\n}'));
    notOk(rc.looksLikeWholeFile(''));
});

test('a code block is labelled by the item it defines, so two blocks are told apart', () => {
    const rc = compiled('ai/rustCode');
    equal(rc.codeBlockLabel('#![no_std]\nfn main() {}'), 'the whole file');
    equal(rc.codeBlockLabel('pub async fn flash_led(interval: u64) {}'), 'fn flash_led');
    equal(rc.codeBlockLabel('impl Display for Led {}'), 'impl Display');
    equal(rc.codeBlockLabel('struct Config {}'), 'struct Config');
    equal(rc.codeBlockLabel('pub const MAX: u32 = 10;'), 'const MAX');
    equal(rc.codeBlockLabel('macro_rules! twice {}'), 'macro twice');
    equal(rc.codeBlockLabel('let x = 1;'), 'the code');
});

test('an item from the chat replaces its own function and leaves the rest of the file alone', () => {
    const rc = compiled('ai/rustCode');
    const file = [
        'use embassy_time::Timer;',
        '',
        'fn flash_led(interval: u64) {',
        '    Timer::after_millis(100).await;',
        '}',
        '',
        'fn other() -> u32 {',
        '    42',
        '}',
        ''
    ].join('\n');
    const refactor = 'fn flash_led(interval: u64) {\n    Timer::after_millis(500).await;\n}\n';
    const out = rc.insertChatCode(file, refactor);
    contains(out, 'Timer::after_millis(500)');
    notContains(out, 'Timer::after_millis(100)');
    contains(out, 'fn other() -> u32 {', 'the function that was not mentioned survives');
    contains(out, 'use embassy_time::Timer;');
    // Exactly one flash_led: a replace that also appended would leave two.
    equal(out.split('fn flash_led').length - 1, 1);
});

test('a brand-new function is added to the file, and the whole file replaces it', () => {
    const rc = compiled('ai/rustCode');
    const file = 'fn existing() {\n    // ...\n}\n';
    const added = rc.insertChatCode(file, 'fn added_from_chat() {\n    // new\n}\n');
    contains(added, 'fn existing()');
    contains(added, 'fn added_from_chat()');

    const replaced = rc.insertChatCode(file, '#![no_std]\n\nfn main() {\n    loop {}\n}\n');
    notContains(replaced, 'fn existing()', 'a whole file is a whole file');
    contains(replaced, '#![no_std]');
});

test('the file\'s own signature and attributes outrank the model\'s', () => {
    const rc = compiled('ai/rustCode');
    // The refactor returns the body only; the entry-point attribute and the parameter list are the file's.
    const file = '#[embassy_executor::main]\nasync fn main(spawner: Spawner) {\n    old();\n}\n';
    const out = rc.insertChatCode(file, 'async fn main(spawner: Spawner) {\n    new();\n}\n');
    contains(out, '#[embassy_executor::main]');
    contains(out, 'new();');
    notContains(out, 'old();');
});
