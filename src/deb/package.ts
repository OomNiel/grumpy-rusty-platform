/* Publishing a firmware project as a Debian package, and the control file it needs.
 *
 * WHY THIS EXISTS (asked 2026-10-05). *"In the Controls section of the Rusty Platform side panel, add a control
 * to publish the project to a .deb file, and another to install the .deb on the host machine. The deb file must
 * land in the project root."*
 *
 * WHAT A `.deb` CAN MEAN FOR FIRMWARE. A Debian package cannot install anything onto a microcontroller — the
 * board is not a package database. What it *can* do, and what this packages, is put the built artifact where a
 * host can flash it: `/usr/share/<package>/` gets the project's `.elf`/`.bin`/`.uf2`, and `/usr/bin/<package>-flash`
 * is a small wrapper that runs `probe-rs` against whichever of them is there. So "install the .deb on the host"
 * means the host now carries that firmware and the command to write it to a board — which is exactly what you
 * want on a second machine, or after deleting the project.
 *
 * WHY THE DECISIONS ARE HERE AND NOT IN THE COMMAND. Every string that ends up in the package — the control
 * file's fields, the file's own name, the wrapper's contents — is a function of its arguments and nothing else,
 * so it can be pinned by a test instead of by building a package and reading it back. `dpkg-deb` refuses a
 * malformed control file with a message about a line number, which is a slow way to find a missing field.
 */

/** Debian's name for a package: lower-case, digits and dashes; a crate name is the starting point. */
export function debianPackageName(crateName: string): string {
    const cleaned = String(crateName ?? '')
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, '-')
        .replace(/[^a-z0-9.+-]/g, '');
    return cleaned.replace(/^[-.]+|[-.]+$/g, '') || 'firmware';
}

/** The file name Debian tools expect: `name_version_arch.deb`. */
export function debFileName(crateName: string, version: string, arch: string): string {
    const name = debianPackageName(crateName);
    const safeVersion = String(version ?? '').trim().replace(/[^A-Za-z0-9.+:~-]/g, '') || '0.0.0';
    const safeArch = String(arch ?? '').trim().replace(/[^a-z0-9]/g, '') || 'all';
    return `${name}_${safeVersion}_${safeArch}.deb`;
}

export interface DebFields {
    /** The crate's own name, as `Cargo.toml` spells it. */
    crateName: string;
    version: string;
    /** `amd64`/`arm64`/`armhf` — the *host* architecture, because that is what dpkg installs onto. */
    architecture: string;
    /** `Name <email>`, the one field dpkg insists on having. */
    maintainer: string;
    description: string;
    /** What the board is, for the long description — the package is for one kind of hardware. */
    board?: string;
    packageSizeBytes?: number;
}

/**
 * The `DEBIAN/control` file, field by field.
 *
 * `Architecture` is the **host's**, not the board's: the payload is data plus a wrapper script that runs on the
 * machine doing the flashing, and declaring `arm64` because the microcontroller is an ARM Cortex-M would make
 * dpkg refuse to install it on the x86-64 laptop it was built for. (`arch` is passed in rather than read from
 * `process.arch` so the decision is testable.)
 */
export function controlFileText(fields: DebFields): string {
    const name = debianPackageName(fields.crateName);
    const sizeKb = fields.packageSizeBytes && fields.packageSizeBytes > 0
        ? Math.max(1, Math.ceil(fields.packageSizeBytes / 1024))
        : undefined;
    const short = String(fields.description ?? '').replace(/\s+/g, ' ').trim() || `${name} firmware`;
    const lines = [
        `Package: ${name}`,
        `Version: ${String(fields.version).trim() || '0.0.0'}`,
        `Architecture: ${String(fields.architecture).trim() || 'all'}`,
        `Maintainer: ${String(fields.maintainer).trim() || 'unknown <unknown@localhost>'}`,
        sizeKb ? `Installed-Size: ${sizeKb}` : undefined,
        `Section: embedded`,
        `Priority: optional`,
        // One line, then indented continuation lines — dpkg reads the description as the first line plus those,
        // and a multi-line *unindented* description is the classic way to get "line 5: field name ...".
        `Description: ${short}`,
        ...longDescription(fields, name)
    ].filter((line): line is string => line !== undefined);
    return `${lines.join('\n')}\n`;
}

function longDescription(fields: DebFields, name: string): string[] {
    const out: string[] = [];
    if (fields.board) out.push(` Firmware for ${fields.board}.`);
    out.push(` Built by Grumpy's Rusty Platform from the "${name}" project.`);
    out.push(' Flashing: run "<name>-flash" with a debug probe attached.'.replace('<name>', name));
    return out.map((line) => line.replace(/^\s?/, ' '));
}

/**
 * The wrapper installed as `/usr/bin/<package>-flash`.
 *
 * `probe-rs run` rather than a raw copy: it is the tool this platform already flashes with, it attaches to the
 * board itself, and it takes an `.elf` (or a `.uf2`) — so the script needs no knowledge of which artifact the
 * project produced. `exec` and `"$@"` mean any extra arguments (`--chip`, a different probe) reach probe-rs.
 */
export function flashWrapperScript(crateName: string, artifactName: string): string {
    const name = debianPackageName(crateName);
    return [
        '#!/bin/sh',
        `# Flash the "${name}" firmware packaged by Grumpy's Rusty Platform.`,
        '#',
        '# The firmware lives in /usr/share/<package>/. A debug probe must be attached; any arguments given',
        '# here are passed straight to probe-rs (for example: ' + name + '-flash --chip RP235x).',
        'set -eu',
        '',
        `DIR=/usr/share/${name}`,
        `ARTIFACT="$DIR/${artifactName}"`,
        '',
        'if [ ! -f "$ARTIFACT" ]; then',
        '    echo "Firmware not found: $ARTIFACT" >&2',
        '    exit 1',
        'fi',
        '',
        'if ! command -v probe-rs >/dev/null 2>&1; then',
        '    echo "probe-rs is not installed. See https://probe.rs/docs/getting-started/installation/" >&2',
        '    exit 1',
        'fi',
        '',
        `echo "Flashing $ARTIFACT"`,
        'exec probe-rs run "$@" "$ARTIFACT"',
        ''
    ].join('\n');
}

/** Why a `.deb` cannot be built at all — said once, in one place, for the command and the control. */
export function debUnsupportedReason(platform: NodeJS.Platform = process.platform): string | undefined {
    if (platform === 'linux') return undefined;
    return 'Debian packages are built and installed with dpkg, which only exists on Linux — so these two controls '
        + 'are Linux-only. The firmware itself builds and flashes fine here.';
}
