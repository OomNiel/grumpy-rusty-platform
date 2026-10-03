'use strict';

/**
 * The house rules the assistant measures from the user's own Rust.
 *
 * Nothing here calls a model: the idioms a reviewer would keep correcting — indentation width, private
 * helpers, `defmt` over `log`, `.unwrap()` over `?`, SCREAMING_SNAKE consts — are counted in the files in
 * front of us. The tests pin two things the prompt depends on: the right rule ids come out with their
 * evidence, and a codebase split roughly 60/40 produces no rule at all (the `MIN_SHARE` guard), because a
 * house style that is only half the code is not a house style.
 */

const { test, ok, notOk, equal, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    deriveConventions,
    normaliseConventions,
    parseConventionsText,
    conventionsText,
    conventionsBlock,
    conventionsTokens,
    MAX_CONVENTIONS,
    MAX_CONVENTION_CHARS,
} = compiled('ai/conventions');

const A = `/// The period the LED stays on.
const LED_PERIOD_MS: u64 = 500;

/// The pin the LED is wired to.
const LED_PIN: u8 = 25;

/// The maximum level.
const MAX_LEVEL: u8 = 3;

/// The minimum level.
const MIN_LEVEL: u8 = 0;

/// The default level.
const DEFAULT_LEVEL: u8 = 1;

/// A blinker.
struct Blinker {
    led: Led,
}

/// A level.
enum Level {
    High,
    Low,
}

/// A colour.
struct Colour;

/// A driver.
trait Driver {
    /// Ticks the driver.
    fn tick(&self);
}

impl Blinker {
    /// Ticks the blinker.
    fn tick(&self) {
        defmt::info!("tick");
        let level = read().unwrap();
        write(level).unwrap();
    }

    /// Resets the blinker.
    fn reset(&self) {
        defmt::info!("reset");
        clear().unwrap();
    }

    /// Stops the blinker.
    fn stop(&self) {
        defmt::info!("stop");
        halt().unwrap();
    }
}

#[cfg(test)]
mod tests {
}
`;

const B = `/// Reads a value.
fn read_value() {
    defmt::info!("read");
    let v = sample().unwrap();
}

#[cfg(test)]
mod tests {}
`;

const C = `/// Writes a value.
fn write_value() {
    defmt::info!("write");
    store().unwrap();
}

/// A small type.
struct Handle;

#[cfg(test)]
mod tests {}
`;

const D = `/// Builds.
fn build_value() {
    defmt::info!("build");
    compute().unwrap();
}

#[cfg(test)]
mod tests {}
`;

const E = `/// Runs.
fn run_value() {
    defmt::info!("run");
    go().unwrap();
}

#[cfg(test)]
mod tests {}
`;

const FIXTURE = [
    { name: 'a.rs', text: A },
    { name: 'b.rs', text: B },
    { name: 'c.rs', text: C },
    { name: 'd.rs', text: D },
    { name: 'e.rs', text: E },
];

test('the expected rules come out of a real project with their evidence', () => {
    const facts = deriveConventions(FIXTURE);
    equal(
        facts.map((f) => f.id),
        ['fn-private', 'error-unwrap', 'log-defmt', 'indent-4', 'doc-comments', 'const-screaming', 'type-camel', 'cfg-test'],
    );
    const byId = Object.fromEntries(facts.map((f) => [f.id, f]));
    equal([byId['fn-private'].samples, byId['fn-private'].total], [8, 8]);
    equal([byId['error-unwrap'].samples, byId['error-unwrap'].total], [8, 8]);
    equal([byId['log-defmt'].samples, byId['log-defmt'].total], [7, 7]);
    equal([byId['indent-4'].samples, byId['indent-4'].total], [25, 25]);
    equal([byId['doc-comments'].samples, byId['doc-comments'].total], [8, 8]);
    equal([byId['const-screaming'].samples, byId['const-screaming'].total], [5, 5]);
    equal([byId['type-camel'].samples, byId['type-camel'].total], [5, 5]);
    equal([byId['cfg-test'].samples, byId['cfg-test'].total], [5, 5]);
    for (const fact of facts) {
        equal(fact.language, 'rust');
        ok(fact.text.length <= MAX_CONVENTION_CHARS);
    }
});

test('a split codebase produces no rule at all', () => {
    // 3 `.unwrap()` against 2 `?`: neither side reaches MIN_SHARE, so there is no error-style house rule.
    const split = [
        {
            name: 'x.rs',
            text: [
                'fn a() {',
                '    let x = foo()?;',
                '    let y = bar()?;',
                '    let z = baz().unwrap();',
                '    let w = qux().unwrap();',
                '    let v = quux().unwrap();',
                '}',
            ].join('\n'),
        },
    ];
    notOk(deriveConventions(split).some((f) => f.id.startsWith('error-')), 'a 60/40 split is not a convention');
});

test('an indentation split produces no indentation rule', () => {
    const split = [
        {
            name: 'x.rs',
            text: ['fn x() {', '    a();', '    b();', '    c();', '  d();', '  e();', '}'].join('\n'),
        },
    ];
    notOk(deriveConventions(split).some((f) => f.id.startsWith('indent-')), '3 of 5 four-space lines is not a rule');
});

test('no files means no rules, and malformed entries are ignored', () => {
    equal(deriveConventions([]), []);
    equal(deriveConventions([{ name: 'x', text: 42 }, null, { name: 'y' }]), []);
});

test('normaliseConventions trims, dedupes, drops over-long rules and caps the list', () => {
    equal(normaliseConventions([' a ', 'a', 'b']), ['a', 'b']);
    equal(normaliseConventions(['a   b']), ['a b']);
    equal(normaliseConventions(42), []);
    equal(normaliseConventions(['x'.repeat(MAX_CONVENTION_CHARS)]).length, 1);
    equal(normaliseConventions(['x'.repeat(MAX_CONVENTION_CHARS + 1)]), []);
    equal(normaliseConventions(Array.from({ length: 15 }, (_, i) => `rule ${i}`)).length, MAX_CONVENTIONS);
    equal(normaliseConventions('- one\n- two'), ['one', 'two']);
});

test('parseConventionsText strips bullets and numbers', () => {
    equal(parseConventionsText('  - alpha\n* beta\n• gamma\n1. delta\n2) epsilon\nplain'), [
        'alpha',
        'beta',
        'gamma',
        'delta',
        'epsilon',
        'plain',
    ]);
    equal(parseConventionsText(''), []);
});

test('conventionsText round-trips a normalised list', () => {
    equal(conventionsText(['a', 'a', ' b ']), 'a\nb');
});

test('conventionsBlock is empty when nothing was accepted, and a bulleted list otherwise', () => {
    equal(conventionsBlock([]), '');
    equal(conventionsBlock(['a', 'b']), [
        "House rules measured from this project's own Rust (follow them; they are how the surrounding code is written):",
        '- a',
        '- b',
    ].join('\n'));
    contains(conventionsBlock(['a'], 'csharp'), '- a', 'the ignored language argument does not change the block');
});

test('conventionsTokens estimates roughly four characters per token', () => {
    equal(conventionsTokens(''), 0);
    equal(conventionsTokens('abcd'), 1);
    equal(conventionsTokens('abcde'), 2);
});
