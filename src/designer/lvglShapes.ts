/**
 * The `path` widget's outline, flattened for `lv_line`.
 *
 * The design stores an SVG-style path in one string (`"M 0 0 L 32 32 Z"`), and the crate walks it with its own
 * parser. LVGL draws polylines, not paths, so the same walk happens here — in TypeScript, at generation time — and
 * what reaches the firmware is a list of points. That also means the §"no trigonometry in the firmware" rule holds:
 * a curve costs nothing at runtime.
 *
 * Curves are flattened into the same **twelve** segments the crate uses (`CURVE_STEPS` in
 * `rusty-gui-widgets/src/lib.rs`), because that number is what makes the canvas and the glass agree; a different
 * step count would draw a visibly different arc.
 *
 * Pure: no `vscode`, no filesystem, so the emitter stays testable and the goldens stay faithful.
 */

/** How many straight segments a curve becomes, on both sides. */
export const CURVE_STEPS = 12;

/** One point of the flattened outline, in the widget's own coordinates. */
export interface ShapePoint {
    x: number;
    y: number;
}

/** A command, as the design's string spells it. */
type Token = { command: string; numbers: number[] };

/**
 * Splits a path string into commands and their numbers.
 *
 * A command letter may be followed by any number of groups (`"l 1 2 3 4"` is two line-tos), which is what the SVG
 * grammar means and what the crate's parser does.
 */
function tokenise(path: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;
    let current: Token | undefined;
    const isNumberStart = (character: string): boolean => /[0-9+\-.]/.test(character);
    while (index < path.length) {
        const character = path[index] ?? '';
        if (/[A-Za-z]/.test(character)) {
            current = { command: character, numbers: [] };
            tokens.push(current);
            index += 1;
            continue;
        }
        if (/\s|,/.test(character)) {
            index += 1;
            continue;
        }
        if (!isNumberStart(character) || current === undefined) {
            index += 1;
            continue;
        }
        let number = '';
        while (index < path.length) {
            const digit = path[index] ?? '';
            if (isNumberStart(digit)) {
                number += digit;
                index += 1;
            } else {
                break;
            }
        }
        const value = Number(number);
        if (Number.isFinite(value)) {
            current.numbers.push(value);
        }
    }
    return tokens;
}

/**
 * The path as a closed or open polyline, in the order it is drawn.
 *
 * A path with more than one `M` is drawn as one polyline through all of it: LVGL's line cannot lift the pen, so the
 * segments are joined — the crate's own multi-subpath support is a drawing detail no design here uses, and joining
 * is visible rather than silent.
 */
export function flattenPath(path: string): ShapePoint[] {
    const points: ShapePoint[] = [];
    let x = 0;
    let y = 0;
    let startX = 0;
    let startY = 0;
    const push = (nextX: number, nextY: number): void => {
        points.push({ x: Math.round(nextX), y: Math.round(nextY) });
        x = nextX;
        y = nextY;
    };
    const line = (toX: number, toY: number): void => {
        push(toX, toY);
    };
    const quadratic = (cx: number, cy: number, toX: number, toY: number): void => {
        const fromX = x;
        const fromY = y;
        for (let step = 1; step <= CURVE_STEPS; step += 1) {
            const t = step / CURVE_STEPS;
            const inverse = 1 - t;
            push(
                inverse * inverse * fromX + 2 * inverse * t * cx + t * t * toX,
                inverse * inverse * fromY + 2 * inverse * t * cy + t * t * toY,
            );
        }
    };
    const cubic = (c1x: number, c1y: number, c2x: number, c2y: number, toX: number, toY: number): void => {
        const fromX = x;
        const fromY = y;
        for (let step = 1; step <= CURVE_STEPS; step += 1) {
            const t = step / CURVE_STEPS;
            const inverse = 1 - t;
            const a = inverse * inverse * inverse;
            const b = 3 * inverse * inverse * t;
            const c = 3 * inverse * t * t;
            const d = t * t * t;
            push(a * fromX + b * c1x + c * c2x + d * toX, a * fromY + b * c1y + c * c2y + d * toY);
        }
    };

    for (const token of tokenise(path)) {
        const relative = token.command === token.command.toLowerCase();
        const numbers = token.numbers;
        switch (token.command.toUpperCase()) {
            case 'M': {
                for (let index = 0; index + 1 < numbers.length; index += 2) {
                    const toX = (numbers[index] ?? 0) + (relative ? x : 0);
                    const toY = (numbers[index + 1] ?? 0) + (relative ? y : 0);
                    if (index === 0) {
                        startX = toX;
                        startY = toY;
                    }
                    push(toX, toY);
                }
                break;
            }
            case 'L': {
                for (let index = 0; index + 1 < numbers.length; index += 2) {
                    line(
                        (numbers[index] ?? 0) + (relative ? x : 0),
                        (numbers[index + 1] ?? 0) + (relative ? y : 0),
                    );
                }
                break;
            }
            case 'H': {
                for (const value of numbers) {
                    line(value + (relative ? x : 0), y);
                }
                break;
            }
            case 'V': {
                for (const value of numbers) {
                    line(x, value + (relative ? y : 0));
                }
                break;
            }
            case 'Q': {
                for (let index = 0; index + 3 < numbers.length; index += 4) {
                    const cx = (numbers[index] ?? 0) + (relative ? x : 0);
                    const cy = (numbers[index + 1] ?? 0) + (relative ? y : 0);
                    const toX = (numbers[index + 2] ?? 0) + (relative ? x : 0);
                    const toY = (numbers[index + 3] ?? 0) + (relative ? y : 0);
                    quadratic(cx, cy, toX, toY);
                }
                break;
            }
            case 'C': {
                for (let index = 0; index + 5 < numbers.length; index += 6) {
                    const c1x = (numbers[index] ?? 0) + (relative ? x : 0);
                    const c1y = (numbers[index + 1] ?? 0) + (relative ? y : 0);
                    const c2x = (numbers[index + 2] ?? 0) + (relative ? x : 0);
                    const c2y = (numbers[index + 3] ?? 0) + (relative ? y : 0);
                    const toX = (numbers[index + 4] ?? 0) + (relative ? x : 0);
                    const toY = (numbers[index + 5] ?? 0) + (relative ? y : 0);
                    cubic(c1x, c1y, c2x, c2y, toX, toY);
                }
                break;
            }
            case 'Z': {
                if (points.length > 0) {
                    push(startX, startY);
                }
                break;
            }
            default:
                // An unsupported command is skipped rather than refusing the whole design: the rest of the outline
                // still draws, which is what the canvas does too.
                break;
        }
    }
    return points;
}
