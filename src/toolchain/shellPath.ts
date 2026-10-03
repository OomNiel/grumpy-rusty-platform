import * as os from 'os';
import * as path from 'path';

/**
 * Making `cargo` reachable from the user's own shells.
 *
 * Our installer runs `rustup-init` with `--no-modify-path` (see installRunner.ts), so
 * `~/.cargo/bin` is never added to a shell profile. The extension's own terminals get an
 * augmented PATH, but a terminal the user opens by hand — or `cargo build` typed into one —
 * still fails with "Command 'cargo' not found" while the binaries are sitting right there.
 *
 * The text is built by pure functions so the t1 layer can pin it, and the write happens only
 * after an explicit confirmation.
 */

/** Marker that makes the block recognisable and the edit idempotent. */
export const PATH_BLOCK_MARKER = "Added by Grumpy's Rusty Platform for VS Code";

/** Where rustup puts its proxies. */
export function cargoBinPath(homeDir: string = os.homedir()): string {
    return path.join(homeDir, '.cargo', 'bin');
}

/**
 * The POSIX block we append. It is safe in `.profile` and `.bashrc` alike: sh has no `local`,
 * no arrays, and the `case` guard means re-running it cannot duplicate the PATH entry.
 */
export function cargoPathBlock(): string {
    return [
        `# ${PATH_BLOCK_MARKER}`,
        '# rustup keeps cargo/rustc/rustup here and does not touch PATH itself.',
        'if [ -d "$HOME/.cargo/bin" ]; then',
        '    case ":$PATH:" in',
        '        *":$HOME/.cargo/bin:"*) ;;',
        '        *) export PATH="$HOME/.cargo/bin:$PATH" ;;',
        '    esac',
        'fi',
        '',
    ].join('\n');
}

export interface ProfileEdit {
    changed: boolean;
    content: string;
    reason: 'appended' | 'already-present';
}

/**
 * Append the block unless the file already mentions `~/.cargo/bin` — which covers both our own
 * marker and a line the user (or rustup's default installer) put there by hand.
 */
export function addCargoToPath(content: string): ProfileEdit {
    if (content.includes('.cargo/bin')) {
        return { changed: false, content, reason: 'already-present' };
    }
    const separator = content === '' ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    return { changed: true, content: `${content}${separator}${cargoPathBlock()}`, reason: 'appended' };
}

/**
 * Profile files worth editing, most specific first. Windows is deliberately empty: PATH is a
 * registry setting there, edited through the environment-variables dialog, not a text file.
 */
export function profileCandidates(platform: NodeJS.Platform): string[] {
    if (platform === 'win32') {
        return [];
    }
    if (platform === 'darwin') {
        return ['.zprofile', '.zshrc', '.profile'];
    }
    return ['.profile', '.bashrc'];
}
