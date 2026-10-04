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

// ---------------- the graphics card's own memory (asked 2026-10-04) ----------------
//
// *"This extension must allow users with high spec hardware to select models that suit their environment."*
// The recommendations could not do that for the GPU, because nothing ever asked: every machine was assumed to
// have the integrated, shared-memory GPU of the laptop this was written on, so any model over 8 GB was pinned
// to the CPU — on a 4090 exactly as on a NUC. Asking the driver is cheap and works without any SDK.

/** `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits` → the first card's VRAM in GB. */
export function parseNvidiaSmiMemory(stdout: string): number | undefined {
    for (const line of String(stdout ?? '').split(/\r?\n/)) {
        const mib = Number(line.trim().split(/[\s,]+/)[0]);
        // MiB, and nothing sane is under 1 GiB or over 1 TiB — a wrong parse here would mis-size every model.
        if (Number.isFinite(mib) && mib >= 1024 && mib <= 1_048_576) return Math.round((mib / 1024) * 10) / 10;
    }
    return undefined;
}

/** `/sys/class/drm/card0/device/mem_info_vram_total` (amdgpu) → GB. Bytes, not MiB. */
export function parseAmdgpuVramGb(text: string): number | undefined {
    const bytes = Number(String(text ?? '').trim());
    if (!Number.isFinite(bytes) || bytes < 1_073_741_824 || bytes > 1_099_511_627_776) return undefined;
    return Math.round((bytes / 1e9) * 10) / 10;
}

/**
 * The dedicated VRAM this machine has, or undefined when it has none this can see.
 *
 * Two cheap, dependency-free sources in order: NVIDIA's own tool, then the amdgpu driver's sysfs file. Intel
 * and Apple silicon GPUs share system memory by design, so "no answer" is the *correct* answer for them — the
 * caller's conservative rule is then the right one, and a user who knows their card can say so with the
 * `gpuVramGb` setting instead of being argued with.
 */
export function readGpuVramGb(): number | undefined {
    try {
        const out = cp.execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], {
            encoding: 'utf8',
            timeout: 2500,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const nvidia = parseNvidiaSmiMemory(out);
        if (nvidia !== undefined) return nvidia;
    } catch {
        /* no NVIDIA driver, or no `nvidia-smi` on PATH — try the kernel's own answer */
    }
    for (const card of ['card0', 'card1', 'card2']) {
        try {
            const bytes = fs.readFileSync(`/sys/class/drm/${card}/device/mem_info_vram_total`, 'utf8');
            const amd = parseAmdgpuVramGb(bytes);
            if (amd !== undefined && isDedicatedAmdVram(amd)) return amd;
        } catch {
            /* not amdgpu, or no such card */
        }
    }
    return undefined;
}

/**
 * Is the figure the amdgpu driver reports a **dedicated** card's memory, or an APU's carve-out?
 *
 * On an AMD APU the same sysfs file reports the slice of *system* RAM set aside for graphics, not separate
 * memory — measured on this machine (2026-10-04): an integrated Radeon reports **3.2 GB**, and its own
 * measurements say offloading the 4.7 GB 7B to it is *faster* (9.7 s against 13.0 s on the CPU). Trusting
 * that number would have made every recommendation here flip to CPU-only, which is the opposite of what the
 * machine wants. So only 8 GB and up is treated as a card; below that the figure is ignored and the
 * conservative shared-memory rule applies, exactly as it did before this existed.
 */
export function isDedicatedAmdVram(vramGb: number): boolean {
    return Number.isFinite(vramGb) && vramGb >= 8;
}
