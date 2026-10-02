import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Tiny `execFile` wrapper.
 *
 * We deliberately use `execFile` (never a shell) for every external tool, so
 * user-supplied values such as project names can never be interpreted as shell
 * syntax. Terminal commands the user explicitly runs *are* shell commands, but
 * those go through `vscode.window.createTerminal` (see src/commands).
 */

export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
    /** True when the executable itself could not be found (ENOENT). */
    notFound: boolean;
}

export interface ExecOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
}

export type ExecFn = (
    cmd: string,
    args: readonly string[],
    options?: ExecOptions,
) => Promise<ExecResult>;

/** `~/.cargo/bin`, where rustup and `cargo install`ed tools live. */
export function cargoBinDir(): string {
    return path.join(os.homedir(), '.cargo', 'bin');
}

/**
 * VS Code launched from a desktop launcher usually has a PATH that does not
 * include `~/.cargo/bin`. Every spawn goes through this so the toolchain is
 * found regardless of how the editor was started.
 */
export function augmentedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const bin = cargoBinDir();
    const current = process.env.PATH ?? '';
    const parts = current.split(path.delimiter).filter((p) => p !== '');
    const merged = parts.includes(bin) ? current : [bin, current].filter(Boolean).join(path.delimiter);
    return { ...process.env, PATH: merged, ...extra };
}

function isExecutableFile(candidate: string): boolean {
    try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) {
            return false;
        }
        if (process.platform === 'win32') {
            return true;
        }
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolve an executable by name. Order: explicit setting -> `~/.cargo/bin` -> PATH.
 * Returns `undefined` when nothing matches, which callers surface as "not installed".
 */
export function findExecutable(name: string, explicitPath?: string): string | undefined {
    if (explicitPath && explicitPath.trim() !== '') {
        return isExecutableFile(explicitPath.trim()) ? explicitPath.trim() : undefined;
    }

    // A bare path (e.g. "C:\tools\probe-rs.exe") is used as-is.
    if (name.includes(path.sep) || (path.sep === '\\' && name.includes('/'))) {
        return isExecutableFile(name) ? name : undefined;
    }

    const candidates: string[] = [];
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const ext of exts) {
        candidates.push(path.join(cargoBinDir(), `${name}${ext}`));
    }

    const pathParts = (process.env.PATH ?? '').split(path.delimiter).filter((p) => p !== '');
    for (const dir of pathParts) {
        for (const ext of exts) {
            candidates.push(path.join(dir, `${name}${ext}`));
        }
    }

    return candidates.find(isExecutableFile);
}

function exitCodeOf(error: unknown): number {
    if (error && typeof error === 'object' && 'code' in error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'number') {
            return code;
        }
    }
    return error ? 1 : 0;
}

function isNotFound(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

export const execFileFn: ExecFn = (cmd, args, options = {}) =>
    new Promise<ExecResult>((resolve) => {
        execFile(
            cmd,
            [...args],
            {
                cwd: options.cwd,
                env: options.env ?? augmentedEnv(),
                timeout: options.timeoutMs ?? 20_000,
                windowsHide: true,
                maxBuffer: 8 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
                resolve({
                    code: exitCodeOf(error),
                    stdout: String(stdout ?? ''),
                    stderr: String(stderr ?? ''),
                    notFound: isNotFound(error),
                });
            },
        );
    });
