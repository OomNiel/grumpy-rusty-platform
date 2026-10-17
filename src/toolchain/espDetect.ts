/**
 * Detecting the Espressif toolchain.
 *
 * Impure on purpose: this is the half that spawns `espup --version`, `espflash --version` and
 * `rustup toolchain list`, and looks for espup's export file. The decision logic lives in
 * `espToolchain.ts`, which stays free of both `vscode` and child processes.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ExecFn } from '../util/exec';
import { augmentedEnv, cargoBinDir, execFileFn } from '../util/exec';
import {
    EXPORT_ESP_FILES,
    EspTool,
    EspToolchainStatus,
    espToolchainReady,
    parseToolchainList,
} from './espToolchain';

export interface EspDetectOptions {
    /** Chips the installed toolchain has to cover, from the boards in use. */
    chips: string[];
    espupPath?: string;
    espflashPath?: string;
    rustupPath?: string;
    /** Directory that holds espup's export file; the home directory by default. */
    homeDir?: string;
}

/** `espup 0.18.0` -> `0.18.0`. */
export function firstVersion(text: string): string | undefined {
    return /\b(\d+\.\d+(?:\.\d+)?)\b/.exec(text)?.[1];
}

/**
 * Find a `cargo install`ed tool.
 *
 * The absolute path in `~/.cargo/bin` is tried first: the extension host is often started from
 * a desktop launcher, whose PATH does not contain it.
 */
async function probeTool(
    exec: ExecFn,
    name: string,
    explicitPath: string | undefined,
): Promise<EspTool> {
    const env = augmentedEnv();
    const candidates =
        explicitPath !== undefined && explicitPath.trim() !== ''
            ? [explicitPath.trim()]
            : [path.join(cargoBinDir(), name), name];

    for (const candidate of candidates) {
        const result = await exec(candidate, ['--version'], { env, timeoutMs: 20_000 });
        if (!result.notFound && result.code === 0) {
            const output = `${result.stdout}${result.stderr}`.trim();
            return { found: true, version: firstVersion(output), path: candidate };
        }
    }
    return { found: false };
}

export async function detectEspToolchain(
    exec: ExecFn,
    options: EspDetectOptions,
): Promise<EspToolchainStatus> {
    const home = options.homeDir ?? os.homedir();
    const env = augmentedEnv();

    const [espup, espflash, toolchains] = await Promise.all([
        probeTool(exec, 'espup', options.espupPath),
        probeTool(exec, 'espflash', options.espflashPath),
        exec(options.rustupPath ?? 'rustup', ['toolchain', 'list'], { env, timeoutMs: 20_000 }),
    ]);

    // espup writes `export-esp.sh` on Unix and `export-esp.ps1` on Windows; whichever exists is
    // the evidence that it has run.
    const exportPath = EXPORT_ESP_FILES.map((file) => path.join(home, file)).find((candidate) =>
        fs.existsSync(candidate),
    );
    const partial = {
        espup,
        espflash,
        // `rustup toolchain list` only shows the espup toolchain after `espup install` has run.
        toolchainInstalled: !toolchains.notFound && parseToolchainList(toolchains.stdout),
        exportFile: exportPath,
        chips: options.chips,
    };
    return { ...partial, ready: espToolchainReady(partial) };
}

/** Detection with the real child-process implementation. */
export function detectEspToolchainNow(options: EspDetectOptions): Promise<EspToolchainStatus> {
    return detectEspToolchain(execFileFn, options);
}
