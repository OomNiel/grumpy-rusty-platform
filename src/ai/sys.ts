/* The three process/network helpers the AI runtime needs — lifted out of the designer's WebSocket client.
 *
 * WHY THIS IS ITS OWN FILE. In the Avalonia Designer these three functions live in `hostClient.ts`, the
 * WebSocket client for the C# PreviewerHost, because that is where they were first needed. This extension
 * has no PreviewerHost and therefore no `ws` dependency (npm dependencies stay empty on purpose), so
 * importing that file would drag in a socket client for a service that does not exist here. The helpers
 * themselves are generic, so they move here unchanged and `runtime.ts`/`llamaServer.ts` import them from
 * `./sys` instead.
 *
 * Nothing here touches `vscode`: a free port, "is this ENOENT" and "run this command and tell me if it
 * worked" are worth testing without an editor.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';

/**
 * A port nobody is listening on, handed back by the OS.
 *
 * The listen-and-close trick is racy in principle (something could take the port between the close and the
 * real server's bind) and is still what everyone does: the window is microseconds wide, and the alternative
 * — probing upward from a fixed number — is a much larger race. `llama-server` is started immediately after.
 */
export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

/** True when a spawn failure means "that program is not installed" — the one failure worth its own sentence. */
export function isMissingExecutable(e: unknown): boolean {
    return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Options for {@link runCmd}: a working directory and an environment, both optional. */
export interface RunOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

/**
 * Runs a command to completion with inherited stdio; rejects with its exit code when it fails.
 *
 * The exit code is a *failure*, never a value: every caller here runs a build or an install where the only
 * interesting outcome is "did it work", and the human-readable reason is in the inherited output.
 */
export function runCmd(cmd: string, args: string[], options: RunOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = cp.spawn(cmd, args, { stdio: 'inherit', cwd: options.cwd, env: options.env });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
    });
}

/**
 * A compiler that can name its own C include directory, or undefined when none is installed.
 *
 * `-print-file-name=include` is how GCC and Clang both report where their built-in headers are; asking beats
 * guessing at `/usr/lib/gcc/<triple>/<version>/include`, whose version changes.
 */
export function gccIncludeDir(): string | undefined {
    for (const compiler of ['cc', 'gcc', 'clang']) {
        try {
            const dir = cp.execFileSync(compiler, ['-print-file-name=include'], { encoding: 'utf8' }).trim();
            if (dir && fs.existsSync(dir)) return dir;
        } catch {
            /* that compiler is not installed — try the next */
        }
    }
    return undefined;
}

/**
 * `BINDGEN_EXTRA_CLANG_ARGS` for a machine whose `libclang` cannot find the C headers on its own.
 *
 * This is the difference between a build and a confusing failure: with `libclang` installed but no `clang`
 * package — a real machine, 2026-10-04 — bindgen resolves `#include <stdbool.h>` to nothing and llama.cpp
 * dies on a header the user has never heard of, in a file they never wrote. The C library's own headers live
 * in `/usr/include` (and the multiarch directory beside it), and the compiler's built-in ones wherever the
 * compiler says. Linux only: the other platforms' toolchains are found by clang on their own.
 */
export function bindgenClangArgs(
    includeDir: string | undefined,
    platform: string = process.platform
): string | undefined {
    if (platform !== 'linux') return undefined;
    const dirs = [
        ...(includeDir ? [includeDir] : []),
        '/usr/include',
        '/usr/include/x86_64-linux-gnu',
        '/usr/include/aarch64-linux-gnu'
    ];
    return dirs.map((dir) => `-I${dir}`).join(' ');
}
