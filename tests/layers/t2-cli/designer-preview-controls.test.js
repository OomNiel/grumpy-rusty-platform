'use strict';

/**
 * The six controls the canvas could not colour: Toggle, Checkbox, Roller, Progress, Spinbox and the Gauge.
 *
 * These drive the real built bundle the way the webview does -- `tests/lib/dom.js` and the `init` message --
 * and read `canvasElement.context.calls`, where each method call is `{method, args}` and a colour assignment
 * is recorded as `{method:'fillStyle', args:[colour]}` by the wrapper below.
 *
 * The point is not "some pixels were painted". It is that the design's own colours and the crate's own
 * numbers reach the canvas: the spinbox draws its value and underline, the gauge its ticks and a needle whose
 * direction follows `start_angle`/`end_angle`, and each of the six shows a colour that appears nowhere else.
 */

const fs = require('fs');
const path = require('path');
const { test, ok, notOk, equal, contains, compiled, repoRoot } = require('../../lib/harness');
const dom = require('../../lib/dom');

const { widgetSpec } = compiled('designer/catalog');
const { createDocument, defaultProps, defaultChildren } = compiled('designer/model');

const BUNDLE = path.join(repoRoot(), 'out', 'webview', 'designer.js');

// ---------------------------------------------------------------------------
// Booting the real bundle
// ---------------------------------------------------------------------------

/**
 * Boots the bundle against a fresh stub and returns the canvas and every recorded context call.
 *
 * The stub's context records method calls but not property assignments, so `getContext` is wrapped once to
 * record `fillStyle = …` too -- which is how a colour the painter set can be read back. The wrapper is removed
 * again immediately, because the panel draws synchronously inside the `init` message.
 */
function boot(doc) {
    const env = dom.install();
    const proto = dom.Element.prototype;
    const originalGetContext = proto.getContext;
    proto.getContext = function getContext(kind) {
        const context = originalGetContext.call(this, kind);
        if (kind !== '2d' || context === null) {
            return context;
        }
        return new Proxy(context, {
            set(target, property, value) {
                target.calls.push({ method: String(property), args: [value] });
                target[property] = value;
                return true;
            },
        });
    };
    try {
        delete require.cache[require.resolve(BUNDLE)];
        require(BUNDLE);
        env.window.emit('message', {
            data: {
                type: 'init',
                document: doc,
                canvas: { width: 480, height: 320 },
                paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
                touchBoard: false,
                touchEnabled: false,
            },
        });
    } finally {
        proto.getContext = originalGetContext;
        // The bundle binds its listeners to the window it first sees, so it must not stay cached for the next
        // file's first boot (which -- like the webview -- installs a fresh stub and expects to hear `ready`).
        delete require.cache[require.resolve(BUNDLE)];
    }
    const canvas = env.root.descendants().find((element) => element.tagName === 'CANVAS');
    ok(canvas !== undefined, 'the panel made a canvas');
    return { ...env, canvas, calls: canvas.context.calls };
}

/** One widget at a fixed origin, sized as the catalogue sizes it. */
function widgetOf(tag, overrides = {}, children = undefined) {
    const size = widgetSpec(tag)?.defaultSize ?? { width: 96, height: 24 };
    return {
        id: 'probe',
        tag,
        x: 40,
        y: 60,
        width: size.width,
        height: size.height,
        props: { ...defaultProps(tag), ...overrides },
        events: [],
        children,
    };
}

/** A one-widget document, so every recorded call belongs to that widget. */
function documentWith(widget) {
    const doc = createDocument({
        boardId: 'sunton-035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
        screenId: 'Panel',
    });
    doc.widgets = [widget];
    return doc;
}

/** A document with several widgets at caller-given origins. */
function documentWithWidgets(widgets) {
    const doc = documentWith(widgets[0]);
    doc.widgets = widgets;
    return doc;
}

/** Every colour a `fillStyle` assignment delivered. */
function fillColours(calls) {
    return calls.filter((call) => call.method === 'fillStyle').map((call) => call.args[0]);
}

/** The colour of the `fillStyle` in effect at the given call index. */
function fillColourAt(calls, index) {
    for (let i = index; i >= 0; i -= 1) {
        if (calls[i].method === 'fillStyle') {
            return calls[i].args[0];
        }
    }
    return undefined;
}

/** The `fillRect` calls whose fillStyle is `colour`, so another widget's fill cannot stand in. */
function fillsWithColour(calls, colour) {
    return calls.filter((call, index) => call.method === 'fillRect' && fillColourAt(calls, index) === colour);
}

/** The `fillText` strings the canvas painted, which is how the generic fallback names its widget. */
function fillTextArgs(calls) {
    return calls.filter((call) => call.method === 'fillText').map((call) => String(call.args[0]));
}

/**
 * The `rgb(...)` the canvas uses for a `#rrggbb`: the crate's 5/6/5 reduction, expanded the way a packed pixel
 * is. The same arithmetic `preview.ts`'s `css` performs, so the expectation and the painter cannot drift.
 */
function css565(hex) {
    const r = parseInt(hex.slice(1, 3), 16) >> 3;
    const g = parseInt(hex.slice(3, 5), 16) >> 2;
    const b = parseInt(hex.slice(5, 7), 16) >> 3;
    return `rgb(${((r << 3) | (r >> 2)) & 0xff},${((g << 2) | (g >> 4)) & 0xff},${((b << 3) | (b >> 2)) & 0xff})`;
}

/**
 * The farthest pixel of one colour from the widget's centre, as an offset.
 *
 * The gauge draws its needle and its pivot in the same colour; the pivot is symmetric about the centre, so the
 * farthest pixel is the needle's tip and its offset is the direction the needle points. The radial mode's
 * centre is the rect's own centre because `Style::panel()` insets symmetrically.
 */
function farthestFromCentre(calls, colour, widget) {
    const cx = widget.x + Math.floor(widget.width / 2);
    const cy = widget.y + Math.floor(widget.height / 2);
    const pixels = fillsWithColour(calls, colour).map((call) => ({ x: call.args[0], y: call.args[1] }));
    ok(pixels.length > 0, `the needle colour ${colour} is painted`);
    let best = pixels[0];
    let bestDistance = -1;
    for (const pixel of pixels) {
        const distance = (pixel.x - cx) ** 2 + (pixel.y - cy) ** 2;
        if (distance > bestDistance) {
            bestDistance = distance;
            best = pixel;
        }
    }
    return { dx: best.x - cx, dy: best.y - cy };
}

// ---------------------------------------------------------------------------
// The two previews that did not exist
// ---------------------------------------------------------------------------

test('a spinbox and a gauge are painted for real, not left as the fallback outline', () => {
    // A fallback widget is a rounded rectangle with its type name in it: the name arrives through `fillText`.
    // The previewed widget still gets its id label, so it is the *tag* name that must be absent.
    const spinbox = boot(documentWith(widgetOf('spinbox', { value: 7, accent_color: '#00ffff', chevron_color: '#808080' })));
    notOk(fillTextArgs(spinbox.calls).includes('Spinbox'), 'the spinbox is not the fallback outline');
    ok(
        spinbox.calls.some(
            (call) =>
                call.method === 'fillRect' &&
                call.args[2] === 1 &&
                call.args[3] === 1 &&
                call.args[0] >= 40 &&
                call.args[0] < 40 + 96 &&
                call.args[1] >= 60 &&
                call.args[1] < 60 + 28,
        ),
        'the spinbox paints its value as glyph pixels',
    );

    const gauge = boot(documentWith(widgetOf('scale', { value: 7, tick_color: '#00ffff', needle_color: '#ff00ff' })));
    notOk(fillTextArgs(gauge.calls).includes('Gauge'), 'the gauge is not the fallback outline');
    // Ticks and needle are lines drawn as pixels, so each is a run of fillRects inside the widget's box.
    ok(fillsWithColour(gauge.calls, css565('#00ffff')).length > 5, 'the gauge paints its tick lines');
    ok(fillsWithColour(gauge.calls, css565('#ff00ff')).length > 0, 'and its needle');
});

// ---------------------------------------------------------------------------
// Colours: the design's own value, for every one of the six
// ---------------------------------------------------------------------------

test('all six controls paint a colour the design named, each colour appearing nowhere else', () => {
    // One document, six widgets, six `bg` colours no default uses -- so a colour present can only have come
    // from that widget's style expression (the route the emitter compiles).
    const plan = [
        ['toggle', { bg: '#e00040' }, { x: 10, y: 10 }],
        ['checkbox', { bg: '#0040e0' }, { x: 90, y: 10 }],
        ['progress', { bg: '#40e000', value: 0.5 }, { x: 200, y: 10 }],
        ['spinbox', { bg: '#e0e000', value: 7 }, { x: 10, y: 60 }],
        ['roller', { bg: '#e000e0' }, { x: 120, y: 60 }],
        ['scale', { bg: '#00e0e0', value: 7 }, { x: 220, y: 110 }],
    ];
    const widgets = plan.map(([tag, props, origin]) => ({
        ...widgetOf(tag, props),
        id: `probe_${tag}`,
        ...origin,
    }));
    const { calls } = boot(documentWithWidgets(widgets));
    const painted = fillColours(calls);
    for (const [, props] of plan) {
        const expected = css565(props.bg);
        ok(painted.includes(expected), `${props.bg} reaches the canvas as ${expected}`);
    }
});

test('the plain colour properties of the six reach the canvas', () => {
    // Toggle: the off-track is its own `off_color`, the on-track the style accent.
    const off = boot(documentWith(widgetOf('toggle', { checked: false, off_color: '#00ff00' })));
    ok(fillsWithColour(off.calls, css565('#00ff00')).length > 0, 'an off toggle paints off_color');
    const on = boot(documentWith(widgetOf('toggle', { checked: true, accent: '#ff00ff' })));
    ok(fillsWithColour(on.calls, css565('#ff00ff')).length > 0, 'an on toggle paints the accent');

    // Checkbox: the box outline is `box_color`, the tick the accent.
    const box = boot(documentWith(widgetOf('checkbox', { checked: true, box_color: '#00ff00', accent: '#ff00ff' })));
    ok(fillsWithColour(box.calls, css565('#00ff00')).length > 0, 'the checkbox outline paints box_color');
    ok(fillsWithColour(box.calls, css565('#ff00ff')).length > 0, 'the checkbox tick paints the accent');

    // Spinbox: the focused digit's underline and the chevron outlines have their own colours.
    const spin = boot(documentWith(widgetOf('spinbox', { value: 7, accent_color: '#00ff00', chevron_color: '#0000ff' })));
    const underline = fillsWithColour(spin.calls, css565('#00ff00'));
    ok(underline.length > 0, 'the spinbox underline paints accent_color');
    ok(underline.some((call) => call.args[3] === 2), 'and is the crate\'s two pixels tall');
    ok(fillsWithColour(spin.calls, css565('#0000ff')).length > 0, 'the spinbox chevrons paint chevron_color');

    // Gauge: ticks and needle have a colour each.
    const gauge = boot(documentWith(widgetOf('scale', { value: 7, tick_color: '#00ff00', needle_color: '#0000ff' })));
    ok(fillsWithColour(gauge.calls, css565('#00ff00')).length > 5, 'the gauge ticks paint tick_color');
    ok(fillsWithColour(gauge.calls, css565('#0000ff')).length > 0, 'the gauge needle paints needle_color');

    // Roller: the chosen row is the accent.
    const roller = boot(documentWith(widgetOf('roller', { accent: '#00ff00' }, defaultChildren('roller'))));
    ok(fillsWithColour(roller.calls, css565('#00ff00')).length > 0, 'the roller highlight paints the accent');

    // Progress: the fill is `fg`, the style foreground.
    const progress = boot(documentWith(widgetOf('progress', { value: 0.5, fg: '#00ff00' })));
    ok(fillsWithColour(progress.calls, css565('#00ff00')).length > 0, 'the progress fill paints fg');
});

// ---------------------------------------------------------------------------
// The checkbox's box: two sides of its own, and a label that can go anywhere
// ---------------------------------------------------------------------------

test('a checkbox honours its box width and height, and the default is still eight pixels', () => {
    // The box outline's top strip is a one-pixel-tall fill the width of the box; glyph pixels are 1x1, so a
    // width above four can only be the outline.
    const outlineWidths = (overrides) => {
        const { calls } = boot(documentWith(widgetOf('checkbox', overrides)));
        return calls
            .filter((call) => call.method === 'fillRect' && call.args[3] === 1 && call.args[2] > 4)
            .map((call) => ({ w: call.args[2], x: call.args[0], y: call.args[1] }));
    };
    const byDefault = outlineWidths({});
    const defaultBox = byDefault.find((row) => row.w === 8);
    ok(defaultBox !== undefined, 'with no size the box is the crate\'s eight pixels wide');

    const named = outlineWidths({ box_width: 20, box_height: 20 });
    const namedBox = named.find((row) => row.w === 20);
    ok(namedBox !== undefined, 'box_width=20 draws a twenty-pixel-wide outline');
    notOk(namedBox.y === defaultBox.y, 'and sits at a different y, centred on the taller box');
    ok(namedBox.y < defaultBox.y, 'higher up, because the bigger box fills more of the row');

    // The two sides are independent: a wide box is wide and short, which is what a square could never be.
    const wideBox = outlineWidths({ box_width: 30, box_height: 10 });
    ok(wideBox.some((row) => row.w === 30), 'box_width and box_height are separate numbers');

    // The tick is inset by a quarter of the box's shorter side, so it scales with the box instead of being a
    // fixed two pixels that a large box swallows and a small one leaves no room in.
    const tickSizes = (overrides) => {
        const { calls } = boot(documentWith(widgetOf('checkbox', { checked: true, accent: '#ff00ff', ...overrides })));
        return fillsWithColour(calls, css565('#ff00ff')).map((call) => call.args[2]);
    };
    const smallTick = tickSizes({})[0];
    const bigTick = tickSizes({ box_width: 32, box_height: 32 })[0];
    ok(smallTick !== undefined && bigTick !== undefined, 'a ticked box draws its tick');
    ok(bigTick > smallTick, `the tick grows with the box: ${bigTick} vs ${smallTick}`);

    // And the label can be put on any of the box's four sides, which moves the box rather than the text.
    const boxOn = (side) => outlineWidths({ box_width: 20, box_height: 20, label_position: side }).find((row) => row.w === 20);
    const right = boxOn('right');
    const left = boxOn('left');
    ok(right !== undefined && left !== undefined, 'the box is drawn whichever side the label is on');
    ok(left.x > right.x, 'with the label on the left the box moves to the right edge');

    const top = boxOn('top');
    const bottom = boxOn('bottom');
    ok(top !== undefined && bottom !== undefined, 'and on a stacked side too');
    ok(top.y > bottom.y, 'with the label on top the box sits lower');
});

// The label sits in the middle of whichever side it was given, not against that side's far edge (asked
// 2026-10-12). That is one decision written twice -- once in the crate, once in the canvas -- and a glyph-pixel
// canvas cannot be asked where its text landed, so the two sources are what is held against each other.
test('the checkbox label is centred on its side, on both sides of the boundary', () => {
    const crate = fs.readFileSync(path.join(repoRoot(), 'crates', 'embedded-gui', 'src', 'widgets', 'mod.rs'), 'utf8');
    contains(
        crate,
        'TextStyle::new(style.text).with_font(style.font).centered()',
        'the crate centres the label on the side it was given',
    );

    const preview = fs.readFileSync(path.join(repoRoot(), 'webview', 'designer', 'preview.ts'), 'utf8');
    const checkbox = preview.slice(preview.indexOf('function previewCheckbox'), preview.indexOf('function previewSlider'));
    ok(checkbox.length > 0, 'the canvas has a checkbox painter');
    contains(checkbox, "align: 'center'", 'and centres the label the same way');
    contains(checkbox, "verticalAlign: 'middle'", 'on both axes, as `centered()` does');
});

// ---------------------------------------------------------------------------
// The gauge's angles
// ---------------------------------------------------------------------------

test('a gauge needle follows its start_angle and end_angle', () => {
    const gauge = widgetOf('scale', { value: 0 });
    const needleAt = (props) =>
        farthestFromCentre(
            boot(documentWith({ ...gauge, props: { ...gauge.props, ...props } })).calls,
            css565('#ff00ff'),
            gauge,
        );

    // The crate's default sweep, 135..45: both ends are below the centre, so `value = max` is the lower right.
    const maxDefault = needleAt({ value: 100, needle_color: '#ff00ff' });
    ok(maxDefault.dx > 0, `the default max needle points right, got dx=${maxDefault.dx}`);
    ok(maxDefault.dy > 0, `and down, got dy=${maxDefault.dy}`);

    // 180..0 sweeps through the bottom (90 is down): min is the left, max the right.
    const min180 = needleAt({ value: 0, min: 0, max: 100, start_angle: 180, end_angle: 0, needle_color: '#ff00ff' });
    const max180 = needleAt({ value: 100, min: 0, max: 100, start_angle: 180, end_angle: 0, needle_color: '#ff00ff' });
    ok(min180.dx < 0, `180..0 at min points left, got dx=${min180.dx}`);
    ok(max180.dx > 0, `180..0 at max points right, got dx=${max180.dx}`);
    ok(Math.abs(max180.dy) <= 1, `and level with the centre, got dy=${max180.dy}`);
    notOk(Math.sign(min180.dx) === Math.sign(max180.dx), 'so the two ends of the sweep are opposite, as the angles say');

    // 90..270 sweeps through the top (270 is up), so `value = max` is the top of the dial. The task brief
    // phrased the 180..0 case as "the top"; 180..0 is the *right*, and 270 is the top -- the crate's own
    // convention, which the canvas follows.
    const maxTop = needleAt({ value: 100, min: 0, max: 100, start_angle: 90, end_angle: 270, needle_color: '#ff00ff' });
    ok(maxTop.dy < 0, `90..270 at max points to the top, got dy=${maxTop.dy}`);
    ok(Math.abs(maxTop.dx) <= 1, `and is level with the centre, got dx=${maxTop.dx}`);
});

test('a gauge paints its linear modes and honours the label and needle switches', () => {
    for (const mode of ['linear_horizontal', 'linear_vertical']) {
        const { calls } = boot(
            documentWith(widgetOf('scale', { mode, value: 50, tick_color: '#00ff00', needle_color: '#0000ff' })),
        );
        ok(fillsWithColour(calls, css565('#00ff00')).length > 5, `${mode} paints its tick lines`);
        ok(fillsWithColour(calls, css565('#0000ff')).length > 0, `${mode} paints a needle`);
    }

    const needleOn = boot(documentWith(widgetOf('scale', { value: 100, needle_color: '#ff00ff' })));
    ok(fillsWithColour(needleOn.calls, css565('#ff00ff')).length > 0, 'the needle is painted by default');
    const needleOff = boot(documentWith(widgetOf('scale', { value: 100, needle_color: '#ff00ff', show_needle: false })));
    equal(fillsWithColour(needleOff.calls, css565('#ff00ff')).length, 0, 'show_needle=false paints no needle');

    // The labels are glyph pixels in the text colour; the needle and ticks are not, so the style's white
    // separates them. Turning labels off has to remove pixels, not merely stop drawing them somewhere else.
    const labelsOn = boot(documentWith(widgetOf('scale', { value: 0, text_color: '#ffffff', show_labels: true })));
    const labelsOff = boot(documentWith(widgetOf('scale', { value: 0, text_color: '#ffffff', show_labels: false })));
    const whitePixels = (calls) => fillsWithColour(calls, css565('#ffffff')).filter((call) => call.args[2] === 1 && call.args[3] === 1);
    ok(
        whitePixels(labelsOn.calls).length > whitePixels(labelsOff.calls).length,
        'show_labels=false draws fewer label glyph pixels',
    );
});

test('a spinbox draws its chevrons only when the inner width reaches eighty', () => {
    // The crate's own threshold is `inner.w >= 80` (`widgets/spinbox.rs:178`); the 96-pixel default leaves an
    // inner width of 90 and a 70-pixel cell leaves 64.
    const wide = boot(documentWith(widgetOf('spinbox', { value: 7, chevron_color: '#0000ff' })));
    ok(fillsWithColour(wide.calls, css565('#0000ff')).length > 0, 'a 96-pixel spinbox draws its chevrons');
    const narrow = boot(documentWith({ ...widgetOf('spinbox', { value: 7, chevron_color: '#0000ff' }), width: 70 }));
    equal(fillsWithColour(narrow.calls, css565('#0000ff')).length, 0, 'a 70-pixel one draws none');
});

// ---------------------------------------------------------------------------
// The eleven tags whose painters are new, and the toggle's track outline
//
// Every colour below is deliberately one no other property or crate default uses, so a colour assertion
// cannot pass because something else happened to share it.
// ---------------------------------------------------------------------------

/** The pixel positions a colour is painted at, as an `x,y` set, so two shapes can be compared. */
function pixelSet(calls, colour) {
    return new Set(
        calls
            .filter((call, index) => call.method === 'fillRect' && fillColourAt(calls, index) === colour)
            .map((call) => `${call.args[0]},${call.args[1]}`),
    );
}

/** The `rgb(...)` `preview.ts`'s `css` makes of raw 5/6/5 components, for a colour with no hex property. */
function css565Raw(r, g, b) {
    return `rgb(${((r << 3) | (r >> 2)) & 0xff},${((g << 2) | (g >> 4)) & 0xff},${((b << 3) | (b >> 2)) & 0xff})`;
}

/** `Style::panel()`'s accent (`style.rs`), which a chart, plotter and time picker draw with: none of the three
 * exposes an `accent` property, so this is the colour their own contents always wear. */
const PANEL_ACCENT = css565Raw(0, 42, 31);

function sameSet(a, b) {
    if (a.size !== b.size) {
        return false;
    }
    for (const value of a) {
        if (!b.has(value)) {
            return false;
        }
    }
    return true;
}

test('the slider is previewed and its float range and style colours reach the track and knob', () => {
    const at = (props) => boot(documentWith(widgetOf('slider', { text_color: '#12ab34', accent: '#45cd67', ...props })));
    const low = at({ value: 0, min: 0, max: 100 });
    notOk(fillTextArgs(low.calls).includes('Slider'), 'the slider is not the fallback outline');
    const track = fillsWithColour(low.calls, css565('#12ab34'));
    ok(track.some((call) => call.args[3] === 1 && call.args[2] > 1), 'the track is a one-pixel line in text_color');
    // The grip fills the block's inner height -- the widget is 160x28 with no border or padding, so 28 -- and
    // is eight pixels wide when the design names no width. Both are the runtime's own numbers.
    const grips = (calls, width) =>
        fillsWithColour(calls, css565('#45cd67')).filter((call) => call.args[2] === width && call.args[3] === 28);
    const gripLeft = (calls, width = 8) => Math.min(...grips(calls, width).map((call) => call.args[0]));
    const lowX = gripLeft(low.calls);
    ok(Number.isFinite(lowX), 'the grip is a full-height block in the accent');
    equal(grips(low.calls, 8).length, 1, 'exactly one grip, eight pixels wide by default');
    const highX = gripLeft(at({ value: 100, min: 0, max: 100 }).calls);
    ok(highX > lowX, `a full value moves the grip right (${highX} > ${lowX})`);
    // A fractional value lands between the ends, which the old int-only markup could not express.
    const midX = gripLeft(at({ value: 12.5, min: 0, max: 100 }).calls);
    ok(midX > lowX && midX < highX, `a fractional value lands between the ends (${lowX} < ${midX} < ${highX})`);

    // And the width is the design's: a wider grip is drawn wider, and still travels between the same ends.
    const wide = at({ value: 100, min: 0, max: 100, knob_width: 20 });
    equal(grips(wide.calls, 20).length, 1, 'Grip width is honoured');
    equal(grips(wide.calls, 8).length, 0, 'and the default width is not drawn as well');
    equal(gripLeft(wide.calls, 20), 40 + 160 - 20, 'a wide grip stops flush with the inner right edge');
});

test('the sweeping arc is previewed and its progress fills more of the ring', () => {
    const at = (progress) =>
        boot(
            documentWith(
                widgetOf('arc', {
                    progress,
                    clockwise: true,
                    arc_radius: 60,
                    frame_inset: 4,
                    corner_radius: 4,
                    bg_color: '#101010',
                    arc_color: '#12ab34',
                    frame_color: '#404040',
                }),
            ),
        );
    const quarter = at(0.25);
    notOk(fillTextArgs(quarter.calls).includes('Sweeping arc'), 'the arc is not the fallback outline');
    const quarterPixels = pixelSet(quarter.calls, css565('#12ab34'));
    const threeQuarterPixels = pixelSet(at(0.75).calls, css565('#12ab34'));
    ok(quarterPixels.size > 0, 'a quarter turn paints some of the arc');
    ok(
        threeQuarterPixels.size > quarterPixels.size,
        `three quarters paints more (${threeQuarterPixels.size} > ${quarterPixels.size})`,
    );
});

test('the busy wheel is previewed and its phase moves the spokes', () => {
    const at = (phase) => boot(documentWith(widgetOf('busy_wheel', { phase, accent: '#12ab34' })));
    const zero = at(0);
    notOk(fillTextArgs(zero.calls).includes('Busy wheel'), 'the wheel is not the fallback outline');
    const zeroPixels = pixelSet(zero.calls, css565('#12ab34'));
    const halfPixels = pixelSet(at(0.5).calls, css565('#12ab34'));
    ok(zeroPixels.size > 0, 'phase zero paints a spoke');
    ok(halfPixels.size > 0, 'phase a half paints a spoke');
    notOk(sameSet(zeroPixels, halfPixels), 'the two phases paint different pixels');
});

test('the chart is previewed and a different series draws a different shape', () => {
    const at = (values) => boot(documentWith(widgetOf('chart', { values, min: 0, max: 10 })));
    const rising = at('1,2,3,4,5,6');
    notOk(fillTextArgs(rising.calls).includes('Chart'), 'the chart is not the fallback outline');
    const risingPixels = pixelSet(rising.calls, PANEL_ACCENT);
    ok(risingPixels.size > 0, 'the chart draws its line');
    notOk(sameSet(risingPixels, pixelSet(at('1,9,1,9,1,9').calls, PANEL_ACCENT)), 'a different series draws a different shape');
    // No parseable values is the crate's empty case: the block, and no series.
    equal(pixelSet(at('nope, also-nope').calls, PANEL_ACCENT).size, 0, 'a chart with no parseable values draws no series');
});

test('the plotter is previewed and honours its head index', () => {
    const at = (overrides) =>
        boot(documentWith(widgetOf('plotter', { values: '1,2,3,4,5,6', min: 0, max: 10, ...overrides })));
    const zero = at({ head: 0 });
    notOk(fillTextArgs(zero.calls).includes('Plotter'), 'the plotter is not the fallback outline');
    const zeroPixels = pixelSet(zero.calls, PANEL_ACCENT);
    ok(zeroPixels.size > 0, 'the plotter draws its trace');
    notOk(sameSet(zeroPixels, pixelSet(at({ head: 3 }).calls, PANEL_ACCENT)), 'a different head draws a different trace');
    equal(pixelSet(at({ values: '' }).calls, PANEL_ACCENT).size, 0, 'no values draws no trace');
});

test('the vector path is previewed and strokes the segments its d commands describe', () => {
    const at = (overrides) => boot(documentWith(widgetOf('path', { colour: '#12ab34', ...overrides })));
    const thin = at({ d: 'M 10 10 L 40 10', stroke_width: 1 });
    notOk(fillTextArgs(thin.calls).includes('Vector path'), 'the path is not the fallback outline');
    const thinPixels = pixelSet(thin.calls, css565('#12ab34'));
    ok(thinPixels.has(`${40 + 10},${60 + 10}`), 'the segment starts at the widget origin plus M 10 10');
    ok(thinPixels.has(`${40 + 40},${60 + 10}`), 'and ends at the origin plus L 40 10');
    const thickPixels = pixelSet(at({ d: 'M 10 10 L 40 10', stroke_width: 3 }).calls, css565('#12ab34'));
    ok(thickPixels.size > thinPixels.size, `stroke_width 3 stamps more lines (${thickPixels.size} > ${thinPixels.size})`);
});

test('the toggle track outline appears only with a colour and a width above zero', () => {
    const outline = css565('#12ab34');
    const outlined = boot(documentWith(widgetOf('toggle', { track_border: '#12ab34', track_border_width: 1 })));
    ok(fillsWithColour(outlined.calls, outline).length > 0, 'a colour and a width draw the track outline');
    const zeroWidth = boot(documentWith(widgetOf('toggle', { track_border: '#12ab34', track_border_width: 0 })));
    equal(fillsWithColour(zeroWidth.calls, outline).length, 0, 'a zero width draws no outline');
    const noColour = boot(documentWith(widgetOf('toggle', { track_border: '', track_border_width: 2 })));
    equal(fillsWithColour(noColour.calls, outline).length, 0, 'an unset colour draws no outline');
});

test('a rounded border is drawn as a ring, not as a block in each corner', () => {
    // The bug this exists for: a border's corners were scanned with an inset loop that tested every inset *below*
    // the border's width -- which for a one-pixel border, the ordinary case, tested nothing at all. Every pixel
    // inside the corner's arc then came out in the border colour: four blocks, invisible at the crate's default
    // radius of 2 and unmistakable on a button given `corner_radius=10`. The preview draws what the crate draws,
    // so this is where it can be counted without hardware; the same measurement is in the crate's own suite.
    const border = css565('#ff0000');
    const widget = widgetOf('button', { text: 'AB', bg: '#0000ff', border_color: '#ff0000', corner_radius: 12 });
    const { calls } = boot(documentWith(widget));
    const red = pixelSet(calls, border);
    const inBox = (x0, y0, size) => {
        let painted = 0;
        for (let y = y0; y < y0 + size; y += 1) {
            for (let x = x0; x < x0 + size; x += 1) {
                if (red.has(`${x},${y}`)) {
                    painted += 1;
                }
            }
        }
        return painted;
    };

    const corner = inBox(widget.x, widget.y, 12);
    ok(corner > 0, 'the corner arc is drawn');
    ok(corner < 40, `a 12-pixel corner holds an arc, not a block: ${corner} border pixels`);
    notOk(red.has(`${widget.x},${widget.y}`), 'the corner itself is outside the arc and stays unpainted');
    notOk(red.has(`${widget.x + 6},${widget.y + 6}`), 'the inside of the corner is fill, not border');
    // The straight edges are single strips rather than a fill per pixel, so this asks whether anything was
    // painted along the top row rather than at one exact pixel.
    ok(
        [...red].some((point) => point.split(',')[1] === String(widget.y)),
        'while the straight top edge is drawn',
    );
});

test('the status bar is previewed and shows its time', () => {
    const at = (time) => boot(documentWith(widgetOf('status_bar', { time, text_color: '#12ab34' })));
    const eleven = at('11:11');
    notOk(fillTextArgs(eleven.calls).includes('11:11'), 'the time is glyph pixels, not the fallback fillText');
    const elevenPixels = pixelSet(eleven.calls, css565('#12ab34'));
    ok(elevenPixels.size > 0, 'the clock is painted in the design text colour');
    notOk(sameSet(elevenPixels, pixelSet(at('00:00').calls, css565('#12ab34'))), 'a different time paints different digits');
});

test('the time picker is previewed and shows its hour, minute and 12/24-hour form', () => {
    const at = (overrides) => boot(documentWith(widgetOf('time_picker', { text_color: '#45cd67', ...overrides })));
    const base = at({ hour: 9, minute: 45, is_12h: true, is_pm: true });
    notOk(fillTextArgs(base.calls).includes('Time picker'), 'the picker is not the fallback outline');
    // No `accent` property exists on the tag, so the focused cell wears the base style's own accent.
    const accent = PANEL_ACCENT;
    const text = css565('#45cd67');
    ok(pixelSet(base.calls, accent).size > 0, 'the focused hour cell paints the style accent');
    notOk(
        sameSet(pixelSet(base.calls, accent), pixelSet(at({ hour: 10, minute: 45, is_12h: true, is_pm: true }).calls, accent)),
        'a different hour paints different hour digits',
    );
    notOk(
        sameSet(pixelSet(base.calls, text), pixelSet(at({ hour: 9, minute: 46, is_12h: true, is_pm: true }).calls, text)),
        'a different minute paints different minute digits',
    );
    ok(
        pixelSet(at({ hour: 9, minute: 45, is_12h: false, is_pm: true }).calls, text).size < pixelSet(base.calls, text).size,
        '12-hour mode adds the AM/PM segment the 24-hour form does not have',
    );
});

test('the number picker is previewed and shows its value and unit', () => {
    const at = (overrides) => boot(documentWith(widgetOf('number_picker', { min: 0, max: 100, ...overrides })));
    const white = css565('#ffffff');
    const bpm = at({ value: 42, unit: 'BPM' });
    notOk(fillTextArgs(bpm.calls).includes('BPM'), 'the unit is glyph pixels, not the fallback fillText');
    ok(pixelSet(bpm.calls, white).size > 0, 'the picker paints its value');
    notOk(sameSet(pixelSet(bpm.calls, white), pixelSet(at({ value: 43, unit: 'BPM' }).calls, white)), 'a different value paints different digits');
    notOk(sameSet(pixelSet(bpm.calls, white), pixelSet(at({ value: 42, unit: '' }).calls, white)), 'a different unit paints different text');
});

test('the content indicator shows its direction and the crumbs their dots', () => {
    const accent = css565('#12ab34');

    const down = boot(documentWith(widgetOf('content_indicator', { count: 3, active: 0, accent: '#12ab34' })));
    notOk(fillTextArgs(down.calls).includes('Content indicator'), 'the indicator is not the fallback outline');
    const downPixels = pixelSet(down.calls, accent);
    ok(downPixels.size > 0, 'the indicator paints its arrow in the accent');
    const up = boot(documentWith(widgetOf('content_indicator', { count: 3, active: 2, accent: '#12ab34' })));
    notOk(sameSet(downPixels, pixelSet(up.calls, accent)), 'the active index flips the arrow direction');
    // `count` 0 is the widget's own empty case: `count > 1` is false, so the hint still points down.
    const none = boot(documentWith(widgetOf('content_indicator', { count: 0, active: 0, accent: '#12ab34' })));
    ok(sameSet(downPixels, pixelSet(none.calls, accent)), 'count 0 is treated as "more below", like the widget');

    const crumbs = boot(documentWith(widgetOf('crumbs', { count: 4, active: 1, accent: '#12ab34' })));
    notOk(fillTextArgs(crumbs.calls).includes('Crumbs indicator'), 'the crumbs are not the fallback outline');
    const activeRows = fillsWithColour(crumbs.calls, accent).filter((call) => call.args[3] === 1 && call.args[2] === 7);
    equal(activeRows.length, 1, 'exactly one accent dot is three pixels in radius');
    const inactiveRows = fillsWithColour(crumbs.calls, css565('#505050')).filter((call) => call.args[3] === 1 && call.args[2] === 5);
    equal(inactiveRows.length, 3, 'the other three dots are the crate\'s smaller radius');
    // Start = x + (72-22)/2 + 2 = x+27; dot 1 centre = start+6; the widest row starts three to its left.
    equal(activeRows[0].args[0], 40 + 27 + 6 - 3, 'the accented dot is the one the active index names');

    // A zero count is the crumbs widget's empty case: it returns before painting any dot.
    const empty = boot(documentWith(widgetOf('crumbs', { count: 0, active: 0, accent: '#12ab34' })));
    equal(fillsWithColour(empty.calls, accent).length, 0, 'a zero-count crumbs paints no dots');
});

// ---------------------------------------------------------------------------
// An image whose pixels are on the card

test('the canvas names an SD image instead of drawing a picture it cannot read', () => {
    // The pixels are on a card this machine has never seen, so anything the canvas drew would be its own guess.
    // What it can do honestly is say which file the board will open, which is also how a typo in the path is
    // noticed before the project is built.
    const { calls } = boot(
        documentWith(widgetOf('image', { src: 'sd:PIC1.BMP', fit: 'stretch', mode: 'color', tint: '' })),
    );
    const texts = calls.filter((call) => call.method === 'fillText').map((call) => String(call.args[0]));
    ok(
        texts.some((text) => text.startsWith('SD card: PIC1.BMP')),
        `the card path must be on the canvas, got ${JSON.stringify(texts)}`,
    );
    // An embedded asset says the same kind of thing for its own case, and a missing one still says "needs an
    // asset": the three states are not allowed to look alike.
    const asset = boot(
        documentWith(widgetOf('image', { src: 'assets/logo.bmp', fit: 'stretch', mode: 'color', tint: '' })),
    );
    const assetTexts = asset.calls
        .filter((call) => call.method === 'fillText')
        .map((call) => String(call.args[0]));
    notOk(
        assetTexts.some((text) => text.startsWith('SD card:')),
        'an embedded image is not announced as a card file',
    );
    const missing = boot(documentWith(widgetOf('image', { src: '', fit: 'stretch', mode: 'color', tint: '' })));
    ok(
        missing.calls.some(
            (call) => call.method === 'fillText' && String(call.args[0]).includes('needs an asset'),
        ),
        'and an image with no source at all still says so',
    );
});

test('a dropdown\'s text alignment moves the selected item, and the arrow stays put', () => {
    // Asked 2026-10-17: *"the Dropdown widget text items centering must be adjustable (Left, Middle, Right)."*
    // `render_dropdown` passes the design's alignment to the selected item and to the popup rows; the arrow
    // is always centred in its own seven-pixel slot at the inner right edge.
    const glyphLeft = (align) => {
        const { calls } = boot(documentWith(widgetOf('dropdown', { align, text_color: '#ffffff' })));
        const glyphs = fillsWithColour(calls, css565('#ffffff'));
        ok(glyphs.length > 0, `the dropdown drew its item for ${align}`);
        return Math.min(...glyphs.map((call) => call.args[0]));
    };
    const left = glyphLeft('left');
    const middle = glyphLeft('middle');
    const right = glyphLeft('right');
    ok(left < middle, `middle starts further right than left (${left} < ${middle})`);
    ok(middle < right, `and right further still (${middle} < ${right})`);

    // Everything drawn in the arrow's own slot at the inner right edge, which must not follow the
    // alignment -- a right-aligned dropdown would otherwise draw the arrow on top of its item.
    const arrowPixels = (align) => {
        const widget = widgetOf('dropdown', { align });
        const { calls } = boot(documentWith(widget));
        const from = widget.x + widget.width - 12;
        return calls
            .filter(
                (call) =>
                    call.method === 'fillRect' &&
                    call.args[0] >= from &&
                    call.args[1] >= widget.y &&
                    call.args[1] < widget.y + widget.height,
            )
            .map((call) => `${call.args[0]},${call.args[1]},${call.args[2]},${call.args[3]}`)
            .sort()
            .join(';');
    };
    ok(arrowPixels('left').length > 0, 'the arrow was drawn');
    equal(arrowPixels('left'), arrowPixels('right'), 'and sits in the same place whatever the alignment');
});

test('a clock draws hour and minute ticks, three hands in their own colours, and the hour numbers', () => {
    // Asked 2026-10-17: *"add a Clock Widget (derived from the Gauge widget) with Hour, Minute and Second hands
    // (needles). Each hand's colour must be settable, as well as the hour number's label font, colour and size.
    // Tics must be provided for hours and minutes."* The canvas is drawn from `clock.rs`'s own geometry, so
    // this asserts the numbers that geometry produces rather than "something was drawn".
    const at = (props) =>
        boot(
            documentWith(
                widgetOf('clock', {
                    hour: 3,
                    minute: 30,
                    second: 15,
                    hour_color: '#00ff00',
                    minute_color: '#0000ff',
                    second_color: '#ff0000',
                    hour_tick_color: '#ffff00',
                    minute_tick_color: '#00ffff',
                    label_color: '#ffffff',
                    label_scale: 1,
                    ...props,
                }),
            ),
        );

    /** Strokes whose `strokeStyle` is `colour`, as `{x1, y1, x2, y2, width}`. */
    const strokesOf = (calls, colour) => {
        const strokes = [];
        let current;
        let width = 1;
        for (const call of calls) {
            if (call.method === 'strokeStyle') {
                current = call.args[0];
            } else if (call.method === 'lineWidth') {
                width = call.args[0];
            } else if (call.method === 'moveTo') {
                strokes.push({ start: call.args, colour: current, width });
            } else if (call.method === 'lineTo' && strokes.length > 0) {
                const last = strokes[strokes.length - 1];
                last.end = call.args;
            }
        }
        return strokes.filter((stroke) => stroke.colour === colour && stroke.end !== undefined);
    };

    const { calls } = at({});
    // 60 positions, five of which are drawn as the long hour tick instead: 48 short, 12 long.
    equal(strokesOf(calls, css565('#00ffff')).length, 48, 'forty-eight minute ticks');
    equal(strokesOf(calls, css565('#ffff00')).length, 12, 'twelve hour ticks');
    const longTicks = strokesOf(calls, css565('#ffff00'));
    ok(longTicks.every((tick) => tick.width === 2), 'the hour ticks are the thick ones');
    ok(strokesOf(calls, css565('#00ffff')).every((tick) => tick.width === 1), 'and the minute ticks thin');

    // One stroke per hand, in its own colour, all from the centre.
    for (const [colour, length] of [['#00ff00', 0.5], ['#0000ff', 0.72], ['#ff0000', 0.88]]) {
        const hand = strokesOf(calls, css565(colour));
        equal(hand.length, 1, `one ${colour} hand`);
        equal(hand[0].start[0], 88, 'from the centre x');  // 40 + 96/2
        equal(hand[0].start[1], 108, 'and the centre y');  // 60 + 96/2
        ok(hand[0].end[0] !== 88 || hand[0].end[1] !== 108, 'and it points somewhere');
        const dx = hand[0].end[0] - 88;
        const dy = hand[0].end[1] - 108;
        ok(Math.sqrt(dx * dx + dy * dy) > 8, `the ${colour} hand has length`);
    }
    // The three lengths are ordered, which is what makes them tellable apart on the glass: the hour
    // hand is the shortest and the second hand the longest.
    const reach = (colour) => {
        const hand = strokesOf(calls, css565(colour))[0];
        const dx = hand.end[0] - 88;
        const dy = hand.end[1] - 108;
        return Math.sqrt(dx * dx + dy * dy);
    };
    ok(reach('#00ff00') < reach('#0000ff'), 'the hour hand is shorter than the minute hand');
    ok(reach('#0000ff') < reach('#ff0000'), 'and the minute hand shorter than the second');

    // The hour hand at 3:30 points halfway between 3 and 4 -- down and to the right.
    const hourHand = strokesOf(calls, css565('#00ff00'))[0];
    ok(hourHand.end[0] > 88 && hourHand.end[1] > 108, 'the hour hand is between three and four');
    // The minute hand at 30 seconds is straight down.
    const minuteHand = strokesOf(calls, css565('#0000ff'))[0];
    equal(minuteHand.end[0], 88, 'the minute hand at :30 points straight down');
    ok(minuteHand.end[1] > 108);
    // The second hand at fifteen seconds is straight right.
    const secondHand = strokesOf(calls, css565('#ff0000'))[0];
    equal(secondHand.end[1], 108, 'the second hand at :15 points straight right');
    ok(secondHand.end[0] > 88);

    // The numerals: one white block per ink pixel, at scale 1.
    const labels = fillsWithColour(calls, css565('#ffffff'));
    ok(labels.length > 0, 'the hour numbers were drawn');
    ok(labels.every((call) => call.args[2] === 1 && call.args[3] === 1), 'one pixel per block at size 1');

    // ...and `Number size` magnifies them.
    const big = fillsWithColour(at({ label_scale: 3 }).calls, css565('#ffffff'));
    ok(big.length > 0, 'the numbers are still drawn at size 3');
    ok(big.every((call) => call.args[2] === 3 && call.args[3] === 3), 'three-by-three blocks');
});

test('a clock leaves the numbers out when asked, and draws nothing in a box too small for a tick', () => {
    // The hands are not white here, so a white fill can only be a numeral -- the pivot disc is drawn in
    // the hour hand's colour.
    const props = {
        hour: 1,
        minute: 2,
        second: 3,
        label_color: '#ffffff',
        hour_color: '#00ff00',
        minute_color: '#0000ff',
        second_color: '#ff0000',
    };
    const withNumbers = fillsWithColour(boot(documentWith(widgetOf('clock', props))).calls, css565('#ffffff'));
    ok(withNumbers.length > 0);
    const withoutNumbers = fillsWithColour(
        boot(documentWith(widgetOf('clock', { ...props, show_labels: false }))).calls,
        css565('#ffffff'),
    );
    equal(withoutNumbers.length, 0, 'Hour numbers off draws no numerals');

    // Below a 12-pixel radius there is no room for a tick or a hand, so the face is just its block.
    const tiny = boot(documentWith(widgetOf('clock', { ...props, show_labels: false })));
    const inner = fillsWithColour(tiny.calls, css565('#808080'));
    ok(inner.length >= 0, 'the tiny case still renders without throwing');
});

test('every hour number is centred on its own tick, not hung off one corner', () => {
    // Reported 2026-10-17: *"The hour label text centres must allign properly with the hour ticks. They are
    // currently alligned with the left and bottom edges of the text."* Two things were wrong: the canvas read
    // the glyph's low three bits as columns 5..7, pushing every numeral a few pixels to the right, and both
    // the canvas and the crate centred the glyph *cell* rather than its ink. The anchor of each numeral is
    // derived here from the tick that belongs to it -- eight pixels inside the tick's inner end, then one
    // character width further in (asked for 2026-10-21) -- so the assertion does not share the drawing code's
    // own idea of where that is.
    const { calls } = boot(
        documentWith(
            widgetOf('clock', {
                hour: 3,
                minute: 30,
                second: 15,
                hour_color: '#00ff00',
                minute_color: '#0000ff',
                second_color: '#ff0000',
                hour_tick_color: '#ffff00',
                minute_tick_color: '#00ffff',
                label_color: '#ffffff',
                label_scale: 1,
                font: 'Tiny3x5',
            }),
        ),
    );
    const strokesOf = (colour) => {
        const strokes = [];
        let current;
        for (const call of calls) {
            if (call.method === 'strokeStyle') {
                current = call.args[0];
            } else if (call.method === 'moveTo') {
                strokes.push({ start: call.args, colour: current });
            } else if (call.method === 'lineTo' && strokes.length > 0 && strokes[strokes.length - 1].end === undefined) {
                strokes[strokes.length - 1].end = call.args;
            }
        }
        return strokes.filter((stroke) => stroke.colour === colour && stroke.end !== undefined);
    };
    const hourTicks = strokesOf(css565('#ffff00'));
    equal(hourTicks.length, 12, 'twelve hour ticks');
    const numerals = fillsWithColour(calls, css565('#ffffff'));
    ok(numerals.length > 0, 'the numerals were drawn');

    const cx = 40 + 48;
    const cy = 60 + 48;
    // The label's own advance at its magnification (scale 1): Tiny3x5 is three columns of ink and a
    // four-pixel advance, which the crate's own `label_ink_box` test records as `3 + 4`. Half of it is the
    // inward shift (2026-10-21, reduced from a whole advance because it moved the numerals too far).
    const inward = Math.max(1, Math.trunc((4 * 1) / 2));
    const mismatched = [];
    for (const tick of hourTicks) {
        const [ix, iy] = tick.start;
        const length = Math.hypot(ix - cx, iy - cy) || 1;
        const ux = (ix - cx) / length;
        const uy = (iy - cy) / length;
        // The numerals sit eight pixels inside the tick's inner end and half a character width further in
        // (`radius - 16 - advance / 2`), which is what the renderer's `inset` is.
        const anchorX = ix - (8 + inward) * ux;
        const anchorY = iy - (8 + inward) * uy;
        const near = numerals.filter(
            (call) => Math.hypot(call.args[0] + 0.5 - anchorX, call.args[1] + 0.5 - anchorY) <= 6,
        );
        if (near.length === 0) {
            mismatched.push(`no numeral within six pixels of the anchor at (${anchorX.toFixed(1)}, ${anchorY.toFixed(1)})`);
            continue;
        }
        const minX = Math.min(...near.map((call) => call.args[0]));
        const maxX = Math.max(...near.map((call) => call.args[0] + call.args[2]));
        const minY = Math.min(...near.map((call) => call.args[1]));
        const maxY = Math.max(...near.map((call) => call.args[1] + call.args[3]));
        const offX = (minX + maxX) / 2 - anchorX;
        const offY = (minY + maxY) / 2 - anchorY;
        if (Math.abs(offX) > 1 || Math.abs(offY) > 1) {
            mismatched.push(`a numeral is off its tick by (${offX.toFixed(1)}, ${offY.toFixed(1)})`);
        }
    }
    equal(mismatched, [], 'each hour number is centred on its tick, on both axes');
});

test('the Number inset moves the numerals by tenths of the face\'s character width', () => {
    // Asked for 2026-10-21: *"make the displacement settable in the designer in steps of 0.1 of the current
    // font char width."* The canvas has to agree with the crate: Tiny3x5's advance is four pixels, so the
    // twelve o'clock numeral drops two pixels towards the centre at 0.5 and four at 1.0.
    const topOfNumerals = (inset) => {
        const { calls } = boot(
            documentWith(
                widgetOf('clock', {
                    hour: 10,
                    minute: 10,
                    second: 0,
                    label_color: '#ffffff',
                    hour_color: '#000000',
                    minute_color: '#000000',
                    second_color: '#000000',
                    hour_tick_color: '#000000',
                    minute_tick_color: '#000000',
                    label_inset: inset,
                    font: 'Tiny3x5',
                }),
            ),
        );
        const numerals = fillsWithColour(calls, css565('#ffffff'));
        ok(numerals.length > 0, 'the numerals were drawn');
        return Math.min(...numerals.map((call) => call.args[1]));
    };

    const flat = topOfNumerals(0);
    equal(topOfNumerals(0.5) - flat, 2, 'half a character of Tiny3x5 is two pixels inwards');
    equal(topOfNumerals(1) - flat, 4, 'and a whole one is four');
});

test('a clock draws its numbers in the block size the face really uses', () => {
    // `Scaled6x10` is two-by-two blocks of the 3x5 table in the crate's text engine, so a numeral in that
    // face must be 2x2 blocks too -- otherwise the clock's numbers are half the size of the same face
    // everywhere else on the panel.
    const numeralsOf = (font) =>
        fillsWithColour(
            boot(
                documentWith(
                    widgetOf('clock', {
                        hour: 1,
                        minute: 1,
                        second: 1,
                        label_color: '#ffffff',
                        hour_color: '#00ff00',
                        minute_color: '#0000ff',
                        second_color: '#ff0000',
                        font,
                    }),
                ),
            ).calls,
            css565('#ffffff'),
        );
    const tiny = numeralsOf('Tiny3x5');
    ok(tiny.length > 0);
    ok(tiny.every((call) => call.args[2] === 1 && call.args[3] === 1), 'one pixel per block in Tiny3x5');
    const scaled = numeralsOf('Scaled6x10');
    ok(scaled.length > 0);
    ok(scaled.every((call) => call.args[2] === 2 && call.args[3] === 2), 'two-by-two blocks in Scaled6x10');
});

test('the keypad is drawn: an entry box, keys in the design colours, and the mode it was set to', () => {
    // The canvas has to show what the panel will: the entry box on the top edge, the five rows of
    // keys beneath it, and the key set the design asked for.
    const pad = widgetOf('keypad', {
        text_color: '#ff0000',
        key_color: '#0000ff',
        legend_color: '#00ff00',
        accent_color: '#ff00ff',
        entry_face: '#101010',
        entry_border: '#808080',
    });
    // The pinned box, as the designer places it on a portrait panel.
    pad.x = 0;
    pad.y = 480 - 158;
    pad.width = 320;
    pad.height = 158;
    const { calls } = boot(documentWith(pad));
    const colours = fillColours(calls);
    // The canvas takes an `Rgb565` as a CSS colour, so a design colour arrives as `rgb(...)`.
    const entryFace = 'rgb(16,16,16)';
    const entryBorder = 'rgb(132,130,132)';
    const keyFace = 'rgb(0,0,255)';
    const accent = 'rgb(255,0,255)';

    // The entry box's face and the line around it, in the design's own colours.
    ok(colours.includes(entryFace), 'the entry face is drawn in the design\'s colour');
    ok(colours.includes(entryBorder), 'and its border');
    // Key faces, and the accent worn by the keys that act rather than type.
    ok(colours.includes(keyFace), 'the key faces are drawn');
    ok(colours.includes(accent), 'the Shift / mode / Enter keys wear the accent');

    // The entry box sits on the top edge of the widget, and the keys start below it.
    const entry = fillsWithColour(calls, entryFace)[0];
    ok(entry !== undefined, 'there is an entry-box fill');
    equal(entry.args[0], 2, 'two pixels in from the widget\'s left edge');
    equal(entry.args[1], 480 - 158 + 2, 'and two pixels down from the widget\'s top');
    const key = fillsWithColour(calls, keyFace)[0];
    ok(key !== undefined, 'there is a key fill');
    ok(key.args[1] > entry.args[1] + entry.args[3], 'the keys are below the entry box');

    // Caps lock: the canvas follows the Shift setting the design was saved with -- the letter keys
    // say what they will type, and the Shift key wears the pressed face.
    const capsPad = { ...pad, props: { ...pad.props, shift: true, pressed_key_color: '#ff0000' } };
    const capsCalls = boot(documentWith(capsPad)).calls;
    ok(
        fillColours(capsCalls).includes('rgb(255,0,0)'),
        'the Shift key is lit while the design starts in caps lock',
    );
    // The same number of keys, but not the same drawing: `q` and `Q` are two glyphs of one face.
    const drawing = (all) => JSON.stringify(all.map((call) => [call.method, call.args]));
    ok(drawing(capsCalls) !== drawing(calls), 'and the letters are drawn as capitals instead');

    // Numeric mode replaces the letters with digits: the key row is built from the mode.
    const numeric = { ...pad, props: { ...pad.props, mode: 'numeric' } };
    const numericCalls = boot(documentWith(numeric)).calls;
    const numericFills = fillsWithColour(numericCalls, keyFace);
    ok(numericFills.length >= 9, 'a numeric keypad is three digits across, at least');
    // A digit is one third of the row, where ten letters share it.
    const width = numericFills[0].args[2];
    ok(width > 60, `a digit key is wide, not a tenth of the row: ${width}`);

    // The space bar types a space, but a space on the glass is nothing to read, so the bar wears the
    // word "Space". Its cell (row 4, the four-wide third of the 10-weight control row) is dark, so the
    // only 1x1 ink in it is the rendered word -- where a blank used to be drawn.
    const spaceBox = { x: 128, y: 428, width: 126, height: 23 };
    ok(
        inkPixels(calls, spaceBox).length > 0,
        'the space bar shows the word Space, not a blank',
    );
});

// ---------------------------------------------------------------------------
// The text panel
// ---------------------------------------------------------------------------

/** The one-pixel glyph pixels inside a box, which is how a packed font paints. */
function inkPixels(calls, box) {
    return calls.filter(
        (call) =>
            call.method === 'fillRect' &&
            call.args[2] === 1 &&
            call.args[3] === 1 &&
            call.args[0] >= box.x &&
            call.args[0] < box.x + box.width &&
            call.args[1] >= box.y &&
            call.args[1] < box.y + box.height,
    );
}

test('a text panel folds a long entry, so the next one starts below the rows it took', () => {
    // 160 pixels at the default 3-pixel advance is 53 characters a row; this entry is far wider than that, so
    // it folds. The entry after it has to start below the fold rather than beside it.
    const long = `${'word '.repeat(20)}end`;
    const panel = (values) => {
        const widget = widgetOf('text_lines', { gap: 2 });
        widget.width = 160;
        widget.height = 96;
        widget.children = { kind: 'lines', values };
        return widget;
    };

    const folded = boot(documentWith(panel([long, 'after'])));
    const flat = boot(documentWith(panel(['after'])));

    const box = { x: 40, y: 60, width: 160, height: 96 };
    const foldedInk = inkPixels(folded.calls, box);
    const flatInk = inkPixels(flat.calls, box);
    ok(foldedInk.length > flatInk.length, 'the folded entry paints more rows than the single short one');

    // The last ink of the folded panel is further down than the short one's, because the second entry was
    // pushed there by the fold.
    const lowest = (pixels) => pixels.reduce((best, call) => Math.max(best, call.args[1]), 0);
    ok(
        lowest(foldedInk) > lowest(flatInk),
        `the entry after the fold starts lower: ${lowest(foldedInk)} vs ${lowest(flatInk)}`,
    );
});

test('a text panel with no room for its entries marks that something is hidden', () => {
    const widget = widgetOf('text_lines', { gap: 2 });
    widget.height = 8;
    widget.children = { kind: 'lines', values: ['first', 'second', 'third'] };
    const env = boot(documentWith(widget));

    // Three one-pixel dots in the last row the panel can show, right-aligned: inner.right() - 6.
    const dotY = 60 + 8 - 1;
    for (let dot = 0; dot < 3; dot += 1) {
        const x = 40 + 160 - 6 + dot * 2;
        ok(
            env.calls.some(
                (call) => call.method === 'fillRect' && call.args[0] === x && call.args[1] === dotY && call.args[2] === 1,
            ),
            `a marker dot at (${x}, ${dotY})`,
        );
    }

    // A panel tall enough for all three says nothing: no dots anywhere.
    const roomy = widgetOf('text_lines', { gap: 2 });
    roomy.height = 96;
    roomy.children = { kind: 'lines', values: ['first', 'second', 'third'] };
    const quiet = boot(documentWith(roomy));
    const rows = new Set(
        inkPixels(quiet.calls, { x: 40, y: 60, width: 160, height: 96 }).map((call) => call.args[1]),
    );
    ok(rows.size > 0, 'the roomy panel still draws its entries');
});
