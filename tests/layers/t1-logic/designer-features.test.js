'use strict';

/**
 * The two cargo features the Designer switches: `sd` and `smtp`.
 *
 * Both exist for the same reason -- *enabling* one is what adds code to the build (the FAT filesystem, the
 * keep-alive client) -- so they share one editor in `designer/features.ts`, and the switches in the toolbar
 * are what move them in and out of `default`. These tests pin the shared rules (a feature moves; its
 * neighbours do not), the definition an older project lacks, and the generator's own starting point.
 */

const { test, ok, notOk, equal, contains, notContains, compiled } = require('../../lib/harness');

const { isFeatureInDefault, setFeatureInDefault, ensureFeatureDefinition } = compiled('designer/features');
const { ensureSmtpFeature } = compiled('smtp/code');
const { generateProjectFiles } = compiled('generate/files');
const { BOARDS } = compiled('boards/catalog');

function board(id) {
    const found = BOARDS.find((candidate) => candidate.id === id);
    ok(found, `unknown board ${id}`);
    return found;
}

function generated(boardId, template, rel) {
    const files = generateProjectFiles({ board: board(boardId), projectName: 'demo', template });
    const file = files.find((candidate) => candidate.path === rel);
    ok(file, `${template} for ${boardId} must produce ${rel}`);
    return file.content;
}

test('each feature moves on its own, and the others stay put', () => {
    const cargo = '[features]\ndefault = ["sd"]\nsd = []\nsmtp = []\n';
    const withSmtp = setFeatureInDefault(cargo, 'smtp', true);
    equal(withSmtp.note, 'added');
    contains(withSmtp.text, 'default = ["sd", "smtp"]', 'SMTP joins the list');
    ok(isFeatureInDefault(withSmtp.text, 'smtp'));
    ok(isFeatureInDefault(withSmtp.text, 'sd'), 'SD is untouched');

    const withoutSd = setFeatureInDefault(withSmtp.text, 'sd', false);
    equal(withoutSd.note, 'removed');
    contains(withoutSd.text, 'default = ["smtp"]');
    notOk(isFeatureInDefault(withoutSd.text, 'sd'));
    ok(isFeatureInDefault(withoutSd.text, 'smtp'));

    // Already there is a no-op, and so is a manifest with no feature table at all.
    equal(setFeatureInDefault(withoutSd.text, 'smtp', true).note, 'none');
    equal(setFeatureInDefault('[package]\nname = "x"\n', 'smtp', true).note, 'none');
});

test('a feature definition is written where the manifest has none', () => {
    const bare = '[package]\nname = "demo"\n\n[dependencies]\nlog = "0.4"\n';
    const defined = ensureFeatureDefinition(bare, 'smtp');
    equal(defined.note, 'added');
    contains(defined.text, '[features]\ndefault = []\nsmtp = []', 'the table and the definition both arrive');
    contains(defined.text, 'log = "0.4"', 'and nothing else changes');
    equal(ensureFeatureDefinition(defined.text, 'smtp').note, 'present', 'a second pass adds nothing');

    // With a table already there, only the missing line is inserted -- after `default`, so the list stays
    // where a reader expects it.
    const existing = '[features]\ndefault = ["sd"]\nsd = ["dep:x"]\n';
    const added = ensureFeatureDefinition(existing, 'smtp');
    equal(added.note, 'added');
    contains(added.text, 'default = ["sd"]\nsmtp = []\nsd = ["dep:x"]');
    equal(ensureFeatureDefinition(added.text, 'smtp').note, 'present');
});

test('a Designer project carries an smtp feature that is off until the wizard runs', () => {
    for (const id of ['sunton-3248s035r', 'lilygo-tqt']) {
        const cargo = generated(id, 'designer', 'Cargo.toml');
        contains(cargo, 'smtp = []', `${id}: the feature exists`);
        notOk(isFeatureInDefault(cargo, 'smtp'), `${id}: but a new project has no client yet`);
    }
    // The templates that are not the Designer have no SMTP client to switch.
    notContains(generated('sunton-3248s035r', 'sdcard', 'Cargo.toml'), 'smtp = []');
    notContains(generated('sunton-3248s035r', 'board', 'Cargo.toml'), 'smtp = []');
});

test('setting SMTP up defines and enables the feature in one step', () => {
    // The wizard's own edit: a project with no table at all (generated before the feature existed) still ends
    // up with a usable switch, and the switch is on because the client was just written.
    const bare = '[package]\nname = "demo"\n\n[dependencies]\nlog = "0.4"\n';
    const ready = ensureSmtpFeature(bare);
    equal(ready.note, 'added');
    contains(ready.text, 'smtp = []');
    contains(ready.text, 'default = ["smtp"]');
    ok(isFeatureInDefault(ready.text, 'smtp'));
    equal(ensureSmtpFeature(ready.text).note, 'present', 're-running the wizard is a no-op');

    // A project that carries both keeps SD where it was.
    const both = ensureSmtpFeature('[features]\ndefault = ["sd"]\nsd = []\n');
    contains(both.text, 'default = ["sd", "smtp"]');
    contains(both.text, 'sd = []');
});
