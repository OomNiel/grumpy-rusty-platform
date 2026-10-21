'use strict';

/**
 * The clock's "Update Time" button in the property panel, driven through the real bundle.
 *
 * The rules behind the button are tested in t1 (`clock-sync.test.js`); what can only be tested here is
 * the half that lives in a browser: that dropping a clock puts the button in its pane, that the button
 * carries its caveat as a tooltip, and that pressing it asks the extension rather than trying to do the
 * work itself -- a webview cannot open a serial port, and the message is the whole contract.
 */

const path = require('path');
const { test, ok, equal, compiled, repoRoot } = require('../../lib/harness');
const dom = require('../../lib/dom');

const { starterDocument } = compiled('designer/generate');

const BUNDLE = path.join(repoRoot(), 'out', 'webview', 'designer.js');

test('dropping a clock offers Update Time, and pressing it asks the extension', () => {
    const { root, messages, window } = dom.install();
    // Each file gets its own DOM, so the bundle has to be evaluated again for it: a cached module was
    // already run against the previous test's window.
    delete require.cache[require.resolve(BUNDLE)];
    require(BUNDLE);

    const document = starterDocument({
        boardId: 'sunton-3248s035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
    });
    window.emit('message', {
        data: {
            type: 'init',
            document,
            canvas: { width: 480, height: 320 },
            paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
            touchBoard: true,
            touchEnabled: false,
        },
    });

    const all = () => root.descendants();

    // A design with no clock has no such button, which is the panel's half of "only if a clock was
    // dropped": there is nothing to press.
    ok(
        !all().some((element) => element.textContent === 'Update Time'),
        'no clock in the design, no button to press',
    );

    // Drop one from the Toolbox: the panel adds it at the centre and selects it, so its pane is what is
    // on screen.
    const clockItem = all().find(
        (element) => element.tagName === 'BUTTON' && element.textContent === 'Clock',
    );
    ok(clockItem !== undefined, 'the Toolbox offers the Clock');
    clockItem.emit('click');

    const update = all().find(
        (element) => element.tagName === 'BUTTON' && element.textContent === 'Update Time',
    );
    ok(update !== undefined, 'the clock\'s pane offers Update Time');
    ok(
        (update.title ?? '').includes('Monitor'),
        'and its tooltip says the port has to be free',
    );

    messages.length = 0;
    update.emit('click');
    const action = messages.find((message) => message.type === 'action');
    ok(action !== undefined, 'pressing it asks the extension');
    equal(action.action, 'updateClockTime', 'with the id the extension acts on');
    equal(
        messages.filter((message) => message.type === 'changed').length,
        0,
        'and it is an action, not an edit: the design is untouched',
    );

    // The other half of the clock's host support: a listener for a board that asks, rather than one
    // push. It is offered from the same pane because it is the same clock the time is for.
    const serve = all().find(
        (element) => element.tagName === 'BUTTON' && element.textContent === 'Answer Time Requests',
    );
    ok(serve !== undefined, 'the clock\'s pane offers the listener too');
    ok((serve.title ?? '').includes('Monitor'), 'and its tooltip names the terminal holding the port');

    messages.length = 0;
    serve.emit('click');
    const listening = messages.find((message) => message.type === 'action');
    ok(listening !== undefined, 'pressing it asks the extension');
    equal(listening.action, 'serveClockTime', 'with the id for the listener');
    equal(
        messages.filter((message) => message.type === 'changed').length,
        0,
        'and it is an action, not an edit either',
    );
});
