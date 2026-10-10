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

const path = require('path');
const { test, ok, notOk, equal, compiled, repoRoot } = require('../../lib/harness');
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
// The checkbox's size, which is what made the box look tiny
// ---------------------------------------------------------------------------

test('a checkbox honours box_size, and the default is still the crate\'s eight pixels', () => {
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

    const named = outlineWidths({ box_size: 20 });
    const namedBox = named.find((row) => row.w === 20);
    ok(namedBox !== undefined, 'box_size=20 draws a twenty-pixel-wide outline');
    notOk(namedBox.y === defaultBox.y, 'and sits at a different y, centred on the taller box');
    ok(namedBox.y < defaultBox.y, 'higher up, because the bigger box fills more of the row');
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
    const knobLeft = (calls) =>
        Math.min(...fillsWithColour(calls, css565('#45cd67')).filter((call) => call.args[2] === 3 && call.args[3] === 5).map((call) => call.args[0]));
    const lowX = knobLeft(low.calls);
    ok(Number.isFinite(lowX), 'the knob is a three-by-five block in the accent');
    const highX = knobLeft(at({ value: 100, min: 0, max: 100 }).calls);
    ok(highX > lowX, `a full value moves the knob right (${highX} > ${lowX})`);
    // A fractional value lands between the ends, which the old int-only markup could not express.
    const midX = knobLeft(at({ value: 12.5, min: 0, max: 100 }).calls);
    ok(midX > lowX && midX < highX, `a fractional value lands between the ends (${lowX} < ${midX} < ${highX})`);
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
