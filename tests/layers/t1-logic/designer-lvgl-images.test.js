'use strict';

/**
 * Pictures, decoded here so LVGL can draw them.
 *
 * The Rust option resolves an asset path at compile time and decodes at run time; LVGL has no decoder, so the
 * generator has to hand it pixels. That makes two things worth pinning: that the two file formats a panel design
 * actually uses come out right, and that the emitter writes an `lv_image_dsc_t` LVGL will accept -- a wrong
 * stride or colour format is a garbled picture nobody can debug from the panel.
 *
 * Every fixture is built here rather than checked in: a two-pixel BMP is four bytes of header and a row, and a
 * PNG is a deflate of one filtered scanline, so the tests carry their own files and cannot drift from the code
 * that reads them.
 */

const zlib = require('node:zlib');

const { test, ok, equal, contains, compiled } = require('../../lib/harness');
const {
    buildCppImages,
    decodeAsset,
    decodeBmp,
    decodePng,
    isOpaque,
    pixelLines,
    toLvglPixels,
} = compiled('designer/lvglImages');
const { emitUiCpp } = compiled('designer/lvgl');
const { createDocument, defaultChildren, defaultProps } = compiled('designer/model');

/** A 2x2, 24-bit bottom-up BMP: the top-left pixel red, then green / blue / white. */
function twoByTwoBmp() {
    const rowBytes = 8; // 2 pixels of 3 bytes, padded to four
    const pixels = Buffer.alloc(rowBytes * 2);
    // Bottom row first in the file: blue, white.
    pixels[0] = 0xff;
    pixels[1] = 0x00;
    pixels[2] = 0x00;
    pixels[3] = 0xff;
    pixels[4] = 0xff;
    pixels[5] = 0xff;
    // Top row: red, green -- a BMP pixel is blue, green, red in that order.
    pixels[8] = 0x00;
    pixels[9] = 0x00;
    pixels[10] = 0xff;
    pixels[11] = 0x00;
    pixels[12] = 0xff;
    pixels[13] = 0x00;
    const header = Buffer.alloc(54);
    header.write('BM', 0, 'ascii');
    header.writeUInt32LE(54 + pixels.length, 2);
    header.writeUInt32LE(54, 10);
    header.writeUInt32LE(40, 14);
    header.writeInt32LE(2, 18);
    header.writeInt32LE(2, 22);
    header.writeUInt16LE(1, 26);
    header.writeUInt16LE(24, 28);
    return Buffer.concat([header, pixels]);
}

/** A 2x2 PNG built chunk by chunk, so the decoder meets a real one rather than a hand-made struct. */
function twoByTwoPng({ alpha = false } = {}) {
    const channels = alpha ? 4 : 3;
    const pixel = (r, g, b, a = 255) => (alpha ? [r, g, b, a] : [r, g, b]);
    const rows = [
        [pixel(0xff, 0x00, 0x00), pixel(0x00, 0xff, 0x00)],
        [pixel(0x00, 0x00, 0xff), pixel(0xff, 0xff, 0xff, 0x80)],
    ];
    // Every row is one filter byte (`0`, "none") followed by its pixels.
    const raw = Buffer.alloc((2 * channels + 1) * 2);
    rows.forEach((row, y) => {
        const base = y * (2 * channels + 1);
        raw[base] = 0;
        row.forEach((values, x) => {
            values.forEach((value, channel) => {
                raw[base + 1 + x * channels + channel] = value;
            });
        });
    });

    const chunk = (type, body) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(body.length);
        const typeAndBody = Buffer.concat([Buffer.from(type, 'ascii'), body]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(typeAndBody) : 0);
        return Buffer.concat([length, typeAndBody, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(2, 4);
    ihdr[8] = 8;
    ihdr[9] = alpha ? 6 : 2;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** One black pixel and one white one: the pair that tells ink from paper. */
function blackAndWhiteBmp() {
    const pixels = Buffer.alloc(8);
    // Bottom-up rows, and this file has only the one: black, then white.
    pixels[0] = 0x00;
    pixels[1] = 0x00;
    pixels[2] = 0x00;
    pixels[3] = 0xff;
    pixels[4] = 0xff;
    pixels[5] = 0xff;
    const header = Buffer.alloc(54);
    header.write('BM', 0, 'ascii');
    header.writeUInt32LE(54 + pixels.length, 2);
    header.writeUInt32LE(54, 10);
    header.writeUInt32LE(40, 14);
    header.writeInt32LE(2, 18);
    header.writeInt32LE(1, 22);
    header.writeUInt16LE(1, 26);
    header.writeUInt16LE(24, 28);
    return Buffer.concat([header, pixels]);
}

function documentWith(widgets) {
    const doc = createDocument({
        boardId: 'pico2w',
        panelWidth: 240,
        panelHeight: 320,
        rotation: 3,
        screenId: 'RustyPanel',
    });
    doc.widgets = widgets;
    return doc;
}

function imageWidget(id, props) {
    return {
        id,
        tag: 'image',
        x: 0,
        y: 0,
        width: 32,
        height: 32,
        props: { ...defaultProps('image'), ...props },
        events: [],
        children: defaultChildren('image'),
    };
}

function iconWidget(id, props, parts) {
    return {
        id,
        tag: 'icon',
        x: 0,
        y: 0,
        width: 32,
        height: 32,
        props: { ...defaultProps('icon'), ...props },
        events: [],
        children: { kind: 'parts', parts },
    };
}

test('a BMP comes out the right way up, and the pixels are the file\'s', () => {
    const decoded = decodeBmp(new Uint8Array(twoByTwoBmp()));
    ok(decoded.ok, `decoded: ${decoded.ok ? '' : decoded.reason}`);
    equal(decoded.image.width, 2, 'two pixels wide');
    equal(decoded.image.height, 2, 'and two deep');
    // A BMP stores its rows bottom-up, so the file's first row is the picture's *last*: the top two pixels are
    // the red and green ones written second in the file.
    equal(Array.from(decoded.image.rgba.slice(0, 4)).join(','), '255,0,0,255', 'top-left is the red pixel');
    equal(Array.from(decoded.image.rgba.slice(4, 8)).join(','), '0,255,0,255', 'and its neighbour is green');
    equal(Array.from(decoded.image.rgba.slice(8, 12)).join(','), '0,0,255,255', 'the second row starts blue');
    equal(Array.from(decoded.image.rgba.slice(12, 16)).join(','), '255,255,255,255', 'and ends white');
});

test('a PNG comes out with its channels in the right order', () => {
    const decoded = decodePng(new Uint8Array(twoByTwoPng()));
    ok(decoded.ok, `decoded: ${decoded.ok ? '' : decoded.reason}`);
    equal(Array.from(decoded.image.rgba.slice(0, 3)).join(','), '255,0,0', 'red stays red');
    equal(Array.from(decoded.image.rgba.slice(4, 7)).join(','), '0,255,0', 'green stays green');
    equal(Array.from(decoded.image.rgba.slice(8, 11)).join(','), '0,0,255', 'and blue stays blue');
    equal(decoded.image.rgba[15], 255, 'an opaque PNG has no alpha to speak of');
    ok(isOpaque(decoded.image), 'which is what decides the colour format');
});

test('a PNG with an alpha channel keeps its alpha, and gets the A8 format', () => {
    const decoded = decodePng(new Uint8Array(twoByTwoPng({ alpha: true })));
    ok(decoded.ok, `decoded: ${decoded.ok ? '' : decoded.reason}`);
    equal(decoded.image.rgba[15], 128, 'the half-transparent corner is half transparent');
    ok(!isOpaque(decoded.image), 'so the picture is not opaque');
    const pixels = toLvglPixels(decoded.image);
    equal(pixels.format, 'LV_COLOR_FORMAT_RGB565A8', 'and LVGL is told to expect the alpha plane');
    equal(pixels.bytes.length, 2 * 2 * 3, 'two colours per pixel plus one alpha');
    equal(pixels.bytes[4 * 2 + 3], 128, 'the alpha plane follows the colours, in row order');
    equal(pixels.stride, 4, 'and a row is still two bytes of colour per pixel');
});

test('RGB565 is the base colour LVGL expects, not the file\'s byte order', () => {
    // Pure red is 0xF800, stored little-endian: the low byte first.
    const pixels = toLvglPixels({ width: 1, height: 1, rgba: new Uint8Array([255, 0, 0, 255]) });
    equal(pixels.format, 'LV_COLOR_FORMAT_RGB565', 'an opaque picture needs no alpha plane');
    equal(Array.from(pixels.bytes).join(','), '0,248', 'red is 0xF800 in the order LVGL reads');
});

test('a format this generator cannot read is a sentence, not a blank box', () => {
    for (const [source, expected] of [
        ['assets/logo.jpg', 'PNG or BMP'],
        ['assets/logo.gif', 'PNG or BMP'],
        ['assets/logo.tiff', 'use PNG or BMP'],
    ]) {
        const result = decodeAsset(new Uint8Array([1, 2, 3]), source);
        equal(result.ok, false, `${source} is refused`);
        contains(result.reason, expected, `and the reason says what to do about ${source}`);
    }
    const missing = buildCppImages(documentWith([imageWidget('logo', { src: 'assets/nope.png' })]), () => undefined);
    equal(missing.problems.length, 1, 'a file that is not there is a problem');
    contains(missing.problems[0], 'is not in the project', 'named in words the person can act on');
});

test('an image widget becomes an lv_image with its pixels in the file', () => {
    const png = twoByTwoPng();
    const document = documentWith([imageWidget('logo', { src: 'assets/logo.png' })]);
    const pictures = buildCppImages(document, (relative) => (relative === 'assets/logo.png' ? new Uint8Array(png) : undefined));
    equal(pictures.problems.length, 0, 'nothing to report');
    ok(pictures.slots.get('logo')?.image !== undefined, 'the picture is decoded');

    const source = emitUiCpp(document, pictures.slots);
    contains(source, 'static const uint8_t img_logo_data[] =', 'the pixels are a table in ui.cpp');
    contains(source, 'static lv_image_dsc_t img_logo;', 'with a descriptor the widget points at');
    contains(source, 'lv_obj_t *w_logo = lv_image_create(', 'the widget is an lv_image');
    contains(source, 'lv_image_set_src(w_logo, &img_logo);', 'fed from that descriptor');
    contains(source, 'ui_image_attach(&img_logo, img_logo_data, 8, LV_COLOR_FORMAT_RGB565, 2, 2, 4);', 'whose header is filled in at build time');
    contains(source, 'lv_image_set_inner_align(w_logo, LV_IMAGE_ALIGN_STRETCH);', 'stretched, which is the default fit');
    contains(source, 'LV_IMAGE_HEADER_MAGIC', 'and the magic number LVGL checks');
    contains(source, 'image->header.stride = (uint16_t)stride;', 'with a stride LVGL can walk');
});

test('fit picks the alignment, and an icon its own', () => {
    const png = new Uint8Array(twoByTwoPng());
    const centred = documentWith([imageWidget('pic', { src: 'assets/pic.png', fit: 'center' })]);
    const centredPictures = buildCppImages(centred, () => png);
    contains(
        emitUiCpp(centred, centredPictures.slots),
        'lv_image_set_inner_align(w_pic, LV_IMAGE_ALIGN_CENTER);',
        'center draws the picture at its own size',
    );
    const icon = documentWith([
        iconWidget('glyph', { align: 'top_left' }, [{ src: 'assets/pic.png', x: 0, y: 0, visible: true, tint: '' }]),
    ]);
    const iconPictures = buildCppImages(icon, () => png);
    contains(
        emitUiCpp(icon, iconPictures.slots),
        'lv_image_set_inner_align(w_glyph, LV_IMAGE_ALIGN_TOP_LEFT);',
        'an icon aligns the way the crate does',
    );
});

test('a design with no pictures emits exactly what it used to', () => {
    const document = documentWith([{ ...imageWidget('plain', {}), tag: 'panel', props: { ...defaultProps('panel') } }]);
    const source = emitUiCpp(document);
    equal(/lv_image/.test(source), false, 'not one image call');
    equal(/ui_image_attach/.test(source), false, 'and no helper either');
});

test('an icon is its parts, thresholded, tinted and scaled', () => {
    // One part of two pixels: black, then white. With the threshold at 100 only the white one is ink, which is
    // what makes the picture transparent in places and forces the RGB565A8 format rather than plain RGB565.
    const document = documentWith([
        iconWidget('glyph', { tint: '#ff0000', threshold: 100, scale: 2 }, [
            { src: 'assets/pic.bmp', x: 0, y: 0, visible: true, tint: '' },
        ]),
    ]);
    const pictures = buildCppImages(document, () => new Uint8Array(blackAndWhiteBmp()));
    equal(pictures.problems.length, 0, 'nothing to report');
    const image = pictures.slots.get('glyph')?.image;
    ok(image !== undefined, 'the icon composed');
    equal(image.width, 4, 'a scale of two doubles the width');
    equal(image.height, 2, 'and the height');
    equal(image.format, 'LV_COLOR_FORMAT_RGB565A8', 'paper is transparent, so the alpha plane is needed');
    // The ink takes the tint, not the file's own white.
    equal(Array.from(image.bytes.slice(2 * 2, 2 * 2 + 2)).join(','), '0,248', 'the ink pixel is the tint, in RGB565');
    const alphaPlane = image.bytes.slice(image.width * image.height * 2);
    equal(alphaPlane[0], 0, 'the black pixel is paper');
    equal(alphaPlane[3], 255, 'and the white one is ink');
});

test('an icon with no parts, or a part on the SD card, says so', () => {
    const empty = buildCppImages(documentWith([iconWidget('glyph', {}, [])]), () => undefined);
    contains(empty.problems[0], 'at least one visible part', 'an empty icon is named');
    const hidden = buildCppImages(
        documentWith([iconWidget('glyph', {}, [{ src: 'assets/a.bmp', x: 0, y: 0, visible: false, tint: '' }])]),
        () => new Uint8Array(twoByTwoBmp()),
    );
    contains(hidden.problems[0], 'at least one visible part', 'and so is one whose parts are all hidden');
    const card = buildCppImages(
        documentWith([iconWidget('glyph', {}, [{ src: 'sd:ICON.BMP', x: 0, y: 0, visible: true, tint: '' }])]),
        () => new Uint8Array(twoByTwoBmp()),
    );
    contains(card.problems[0], 'SD card', 'a card image is a named limitation, not a crash');
});

test('the pixel table is one escape per byte, so no digit is swallowed', () => {
    const lines = pixelLines(new Uint8Array([0x12, 0x0a, 0xff]), '  ');
    equal(lines.join(''), '  "\\x12\\x0a\\xff"', 'hex digits stay inside their own escape');
    const long = pixelLines(new Uint8Array(40), '');
    equal(long.length, 3, 'sixteen bytes to a line');
    equal(long[0].length, 16 * 4 + 2, 'which is what makes a 20 KB picture readable');
});
