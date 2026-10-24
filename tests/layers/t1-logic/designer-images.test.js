'use strict';

/**
 * The pictures a design names, on their way to the canvas.
 *
 * The panel is a webview and cannot read the project, so an image widget used to be drawn as an empty box — and a
 * view holding only an image therefore looked blank (reported 2026-10-24). The extension now reads each file and
 * sends it as a data URL for the *browser* to decode, which is why there is no image parser here to test: what is
 * tested is which files are chosen, how they are labelled, and what is deliberately left out.
 */

const { test, ok, equal, compiled } = require('../../lib/harness');
const { collectImageAssets, imageSourcesOf, mimeFor, MAX_CANVAS_IMAGE_BYTES } =
    compiled('designer/imageAssets');
const { createDocument, defaultChildren, defaultProps } = compiled('designer/model');

function document(widgets) {
    const doc = createDocument({
        boardId: 'lilygo-tqt',
        panelWidth: 128,
        panelHeight: 128,
        rotation: 0,
        screenId: 'Panel',
    });
    doc.widgets = widgets;
    return doc;
}

function image(id, src, view) {
    return {
        id,
        tag: 'image',
        x: 0,
        y: 0,
        width: 128,
        height: 128,
        props: { ...defaultProps('image'), src },
        events: [],
        children: defaultChildren('image'),
        ...(view === undefined ? {} : { view }),
    };
}

test('the picture a design names is what gets sent, once each', () => {
    const doc = document([
        image('photo', 'assets/photo.bmp'),
        image('again', 'assets/photo.bmp'),
        image('card', 'sd:/HOLIDAY.BMP'),
        entry(),
    ]);

    equal(
        imageSourcesOf(doc),
        ['assets/photo.bmp'],
        'the file is named once, and the one on the card is not a file the canvas can read',
    );
});

test('an icon\'s parts are pictures too, and each one counts', () => {
    const icon = {
        id: 'status',
        tag: 'icon',
        x: 0,
        y: 0,
        width: 32,
        height: 32,
        props: { ...defaultProps('icon') },
        events: [],
        children: {
            kind: 'parts',
            parts: [
                { src: 'assets/shell.bmp', x: 0, y: 0 },
                { src: 'assets/bolt.bmp', x: 3, y: 1 },
            ],
        },
    };
    equal(
        imageSourcesOf(document([icon])),
        ['assets/shell.bmp', 'assets/bolt.bmp'],
        'every part is a file of its own',
    );
});

test('the bytes travel with a type the browser can decode, and what cannot be previewed is left out', () => {
    const doc = document([image('photo', 'assets/photo.bmp'), image('shot', 'assets/shot.png')]);
    const bytes = (relative) =>
        relative === 'assets/photo.bmp'
            ? new Uint8Array([66, 77, 1, 2, 3])
            : relative === 'assets/shot.png'
                ? new Uint8Array([137, 80, 78, 71])
                : undefined;

    const assets = collectImageAssets(doc, bytes);
    equal(assets.map((asset) => asset.src), ['assets/photo.bmp', 'assets/shot.png'], 'both files, in order');
    equal(assets[0].mime, 'image/bmp', 'a BMP says so');
    equal(assets[1].mime, 'image/png', 'and a PNG says so');
    equal(Buffer.from(assets[0].data, 'base64').toString('hex'), '424d010203', 'the bytes are the file, base64');

    // A file that is not there is reported by the panel already; sending nothing is the right answer here.
    equal(collectImageAssets(document([image('gone', 'assets/gone.bmp')]), () => undefined).length, 0);

    // And a file too big to be worth a message keeps the widget's placeholder instead of a round trip.
    const huge = new Uint8Array(MAX_CANVAS_IMAGE_BYTES + 1);
    equal(collectImageAssets(document([image('big', 'assets/big.jpg')]), () => huge).length, 0);

    equal(mimeFor('assets/thing.gif'), 'image/gif');
    equal(mimeFor('assets/no-extension'), 'application/octet-stream', 'an unknown file is still described honestly');
});

/** A widget that is not a picture, so the source list has something to leave out. */
function entry() {
    return {
        id: 'label',
        tag: 'label',
        x: 0,
        y: 0,
        width: 40,
        height: 16,
        props: { ...defaultProps('label') },
        events: [],
        children: defaultChildren('label'),
    };
}
