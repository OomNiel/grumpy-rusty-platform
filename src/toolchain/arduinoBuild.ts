/**
 * The commands a C++ project is built, uploaded and monitored with, and the diagnostics they produce.
 *
 * Everything here is pure: it builds argv arrays and parses `arduino-cli`'s JSON, so the t1 layer can pin the
 * exact command line and the exact parse without an installed toolchain. `src/commands/arduinoCommands.ts`
 * is what runs them.
 *
 * Why `--output-dir build`: `arduino-cli compile` without one puts the artifacts in a temporary folder that
 * the next run may not reuse, and `upload` would then rebuild from scratch or complain. One folder inside the
 * project (gitignored) is what makes "Build, then Upload" behave like one action.
 */

import * as path from 'path';
import type { CompilerDiagnostic } from '../ai/cargoMessages';
import { ARDUINO_BUILD_DIR } from '../generate/arduinoIntelliSense';

/** Where `compile` writes its artifacts, relative to the project. Also in the generated `.gitignore`. */
export const ARDUINO_ARTIFACT_DIR = 'build';

/** 115200 is what `Serial.begin(115200)` in every generated sketch uses. */
export const ARDUINO_BAUD = 115_200;

/**
 * The compile command.
 *
 * `--build-path` is not an optimisation: arduino-cli compiles a *copy* of the sketch, and without it that copy
 * lives in a temporary directory whose name changes between runs. Pointing it at `.arduino/build` is what makes
 * a diagnostic name a file inside the project (`…/.arduino/build/sketch/src/ui.cpp`) instead of one under
 * `/tmp`, and it is also what keeps the editor's compilation database current for free.
 *
 * The two `--build-property` arguments are LVGL's: LVGL looks for `lv_conf.h` two levels above its own config
 * header unless `LV_CONF_INCLUDE_SIMPLE` is defined, and then looks for it on the include path — so the flag
 * and the project root go together. Without them a designer project builds with LVGL's defaults at 32 bits per
 * pixel, which silently draws nothing useful on this glass. A project without a `lv_conf.h` (blinky, display)
 * gets neither, so it still needs no library at all.
 */
export function compileArgs(fqbn: string, projectDir?: string, hasLvConf = false): string[] {
    const args = [
        'compile',
        '--fqbn',
        fqbn,
        '--build-path',
        ARDUINO_BUILD_DIR,
        '--output-dir',
        ARDUINO_ARTIFACT_DIR,
    ];
    return [...args, ...lvConfBuildProperties(projectDir, hasLvConf)];
}

/**
 * The `--build-property` pair that points LVGL at the project's own `lv_conf.h`.
 *
 * Exported because the IntelliSense refresh has to pass exactly these: a database generated without them
 * describes a project with no LVGL in it, and the Problems pane then reports `lv_conf.h` and every `lv_obj_t`
 * as missing while the build is fine (bench, 2026-10-31).
 */
export function lvConfBuildProperties(projectDir?: string, hasLvConf = false): string[] {
    if (!hasLvConf || projectDir === undefined) {
        return [];
    }
    const flags = `-DLV_CONF_INCLUDE_SIMPLE -I${projectDir}`;
    return [
        '--build-property',
        `compiler.cpp.extra_flags=${flags}`,
        '--build-property',
        `compiler.c.extra_flags=${flags}`,
    ];
}

/**
 * The project file a diagnostic is really about.
 *
 * arduino-cli reports the path of the copied sketch, so a message about `…/.arduino/build/sketch/src/ui.cpp` has
 * to become `…/src/ui.cpp` before it is put on the Problems pane — otherwise the editor opens a file that the
 * next build overwrites, and a fix applied there is thrown away.
 */
export function projectPathOf(file: string, projectDir: string): string {
    const copyRoot = path.join(projectDir, ARDUINO_BUILD_DIR, 'sketch');
    const normalised = path.normalize(file);
    if (normalised.startsWith(copyRoot + path.sep)) {
        return path.join(projectDir, normalised.slice(copyRoot.length + 1));
    }
    return normalised;
}

export function uploadArgs(fqbn: string, port: string): string[] {
    return ['upload', '--fqbn', fqbn, '-p', port, '--input-dir', ARDUINO_ARTIFACT_DIR];
}

export function monitorArgs(port: string): string[] {
    return ['monitor', '-p', port, '--config', `baudrate=${ARDUINO_BAUD}`];
}

/** The one line a person needs from a failed run, without the tool's whole banner above it. */
export function lastLineOf(text: string): string {
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    return lines.length === 0 ? '' : (lines[lines.length - 1] ?? '');
}

/**
 * `arduino-cli compile --format json`'s diagnostics, as the extension's own shape.
 *
 * The JSON is `{"compiler_out": ..., "compiler_err": ..., "builder_result": {"diagnostics": [...]}}`. Each
 * diagnostic carries `severities` ("ERROR"/"WARNING"), a list of `locations` (`file`, `line`, `column`) and a
 * `message`. Anything unparseable yields an empty list: a build that failed for a reason the JSON does not
 * describe is reported from the raw output instead, never as "no errors".
 */
export function parseCompileJson(stdout: string): CompilerDiagnostic[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return [];
    }
    const builder = (parsed as { builder_result?: { diagnostics?: unknown } } | null)?.builder_result;
    const diagnostics = builder?.diagnostics;
    if (!Array.isArray(diagnostics)) {
        return [];
    }

    const out: CompilerDiagnostic[] = [];
    for (const entry of diagnostics) {
        if (entry === null || typeof entry !== 'object') {
            continue;
        }
        const diagnostic = entry as {
            severities?: unknown;
            message?: unknown;
            locations?: unknown;
        };
        if (typeof diagnostic.message !== 'string') {
            continue;
        }
        const severities = Array.isArray(diagnostic.severities) ? diagnostic.severities : [];
        const severity = severities.includes('ERROR')
            ? 'error'
            : severities.includes('WARNING')
                ? 'warning'
                : undefined;
        if (severity === undefined) {
            continue; // NOTICE, or something the editor's Problems pane has no place for
        }
        const locations = Array.isArray(diagnostic.locations) ? diagnostic.locations : [];
        for (const location of locations) {
            const place = location as { file?: unknown; line?: unknown; column?: unknown };
            if (typeof place.file !== 'string') {
                continue;
            }
            out.push({
                file: place.file,
                line: typeof place.line === 'number' ? place.line : 1,
                column: typeof place.column === 'number' ? place.column : 1,
                severity,
                // gcc has no error codes; the toolchain keeps the field so one shape serves both languages.
                code: '',
                message: diagnostic.message,
            });
        }
    }
    return out;
}

/**
 * gcc's own `file:line:col: error: message` lines, for builds whose JSON says nothing.
 *
 * arduino-cli reports a compile error both ways in most versions, but a failure in the *linker*, in
 * `picotool`, or in a core's own tool has only the text. This is the fallback that keeps those on the Problems
 * pane too.
 */
export function parseGccText(text: string): CompilerDiagnostic[] {
    const out: CompilerDiagnostic[] = [];
    // `C:\path\file.cpp:12:5: error: msg` on Windows, `/path/file.cpp:12:5: error: msg` elsewhere.
    const pattern = /^(.+?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/;
    for (const line of text.split('\n')) {
        const match = pattern.exec(line.trim());
        if (match === null) {
            continue;
        }
        const severity = match[4] === 'error' || match[4] === 'fatal error' ? 'error' : match[4] === 'warning' ? 'warning' : undefined;
        if (severity === undefined) {
            continue; // a note belongs to the error above it, which is already in the list
        }
        out.push({
            file: match[1] ?? '',
            line: Number(match[2]),
            column: Number(match[3]),
            severity,
            code: '',
            message: match[5] ?? '',
        });
    }
    return out;
}

/**
 * Everything worth putting in the Problems pane for one build, deduplicated.
 *
 * The JSON and the text describe the same errors in a successful arduino-cli run, so a plain concatenation
 * would double every entry. The identity used here is file + line + message, which is the same error whichever
 * way it was reported.
 */
export function collectDiagnostics(stdout: string, stderr: string): CompilerDiagnostic[] {
    const seen = new Set<string>();
    const out: CompilerDiagnostic[] = [];
    for (const diagnostic of [...parseCompileJson(stdout), ...parseGccText(`${stdout}\n${stderr}`)]) {
        const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.severity}:${diagnostic.message}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(diagnostic);
    }
    return out;
}

/** Where each artifact of a successful build lands, for the "it built" message. */
export function artifactNames(fqbn: string): string[] {
    // arduino-pico copies a .uf2, arduino-esp32 a merged .bin; the ELF is always there and is what a debugger
    // would want, so it is named either way.
    const common = ['.elf'];
    const family = fqbn.startsWith('esp32:') ? ['.bin', '.bootloader.bin', '.partitions.bin'] : ['.uf2'];
    return [...common, ...family];
}
