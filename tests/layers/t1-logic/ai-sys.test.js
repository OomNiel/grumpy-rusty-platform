'use strict';

/**
 * The two small machine-facing helpers the AI runtime needs: a free port and a working build environment.
 *
 * `bindgenClangArgs` exists because of a real failure (2026-10-04): with `libclang` installed but no `clang`
 * package, bindgen resolved `#include <stdbool.h>` to nothing and the sidecar's first build died on a header
 * in llama.cpp the user had never heard of. The decision — which include paths to hand it — is a pure
 * function of the compiler's own answer and the platform, so it is pinned here; `gccIncludeDir` itself
 * spawns a compiler and is only checked for sanity.
 */

const fs = require('fs');
const { test, ok, equal } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const sys = compiled('ai/sys');

test('bindgen is told where the C headers are on Linux', () => {
    const args = sys.bindgenClangArgs('/usr/lib/gcc/x86_64-linux-gnu/13/include', 'linux');
    ok(args.includes('-I/usr/lib/gcc/x86_64-linux-gnu/13/include'), 'the compiler’s own headers');
    ok(args.includes('-I/usr/include'), 'the C library’s headers');
    ok(args.includes('-I/usr/include/x86_64-linux-gnu'), 'and the multiarch directory beside them');
});

test('the C library headers are offered even with no compiler to ask', () => {
    const args = sys.bindgenClangArgs(undefined, 'linux');
    ok(args.includes('-I/usr/include'), `expected /usr/include in ${args}`);
});

test('other platforms are left alone — clang finds its own toolchain there', () => {
    equal(sys.bindgenClangArgs('/x', 'darwin'), undefined);
    equal(sys.bindgenClangArgs('/x', 'win32'), undefined);
});

test('gccIncludeDir asks a compiler rather than guessing a versioned path', () => {
    const dir = sys.gccIncludeDir();
    // A machine with no compiler at all is allowed to say "no"; a machine with one must name a real folder.
    ok(dir === undefined || fs.existsSync(dir), `gccIncludeDir -> ${dir}`);
    if (dir) ok(dir.includes('include'), `expected an include directory, got ${dir}`);
});
