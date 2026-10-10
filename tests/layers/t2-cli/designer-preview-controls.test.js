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
