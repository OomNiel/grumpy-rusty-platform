/**
 * The Espressif toolchain: what `espup` installs and how we know it is there.
 *
 * An ESP project cannot be built with a plain rustup toolchain. The Xtensa targets only exist
 * in Espressif's fork of rustc, which `espup` installs as a second toolchain, and the linker
 * comes from an Espressif GCC that only appears on PATH after `source $HOME/export-esp.sh`.
 * `espflash` does the flashing.
 *
 * The pure half of this file (the plan, the parsers, the readiness rule) is deliberately free
 * of any `vscode` import, so the t1 layer can test it without a real toolchain -- and so the
 * same plan can be shown in a terminal, a notification or the toolchain view.
 */

export const ESPUP_CRATE = 'espup';
export const ESPFLASH_CRATE = 'espflash';

/** The rustup toolchain name espup uses by default (`espup install --name`). */
export const ESP_TOOLCHAIN_NAME = 'esp';

/** The file espup writes; sourcing it puts the Xtensa linker on PATH. */
export const EXPORT_ESP_FILE = 'export-esp.sh';

export interface EspTool {
    found: boolean;
    version?: string;
    path?: string;
}

export interface EspToolchainStatus {
    espup: EspTool;
    espflash: EspTool;
    /** True when `rustup toolchain list` lists the espup-installed toolchain. */
    toolchainInstalled: boolean;
    /** Absolute path of `$HOME/export-esp.sh`, when it exists. */
    exportFile?: string;
    /** Chips the installed toolchain has to cover, e.g. `['esp32', 'esp32s3']`. */
    chips: string[];
    ready: boolean;
}

/**
 * Chips an `espup install --targets ...` run has to cover, from target triples.
 *
 * `xtensa-esp32s3-none-elf` -> `esp32s3`. Installing only the chips in use keeps the download
 * to what the user's boards actually need.
 */
export function chipsForTargets(targets: string[]): string[] {
    const chips = targets
        .filter((target) => target.startsWith('xtensa-'))
        .map((target) => target.slice('xtensa-'.length).replace(/-none-elf$/, ''))
        .filter((chip) => chip !== '');
    return [...new Set(chips)].sort();
}

/** What is still missing, in the order it has to be installed. Empty when ready. */
export function missingEspPieces(status: Omit<EspToolchainStatus, 'ready'>): string[] {
    const missing: string[] = [];
    if (!status.espup.found) {
        missing.push('espup');
    }
    if (!status.toolchainInstalled) {
        missing.push('toolchain');
    }
    if (status.exportFile === undefined) {
        missing.push('export-esp.sh');
    }
    if (!status.espflash.found) {
        missing.push('espflash');
    }
    return missing;
}

export function espToolchainReady(status: Omit<EspToolchainStatus, 'ready'>): boolean {
    return missingEspPieces(status).length === 0;
}

export interface EspInstallStep {
    id: string;
    label: string;
    /** The shell command, as it should be typed. */
    command: string;
    detail: string;
}

/**
 * The commands that turn a bare machine into one that can build and flash an ESP project.
 *
 * Order matters: `espup` installs the toolchain, and `espflash` is a normal cargo install.
 * The export file is not a step -- sourcing it only affects the shell it runs in, so the
 * extension reads it and injects the variables instead (see `parseExportEsp`).
 */
export function espInstallCommands(
    status: Omit<EspToolchainStatus, 'ready'>,
    chips: string[],
): EspInstallStep[] {
    const missing = missingEspPieces(status);
    const steps: EspInstallStep[] = [];

    if (missing.includes('espup')) {
        steps.push({
            id: 'espup',
            label: 'Install espup',
            command: `cargo install ${ESPUP_CRATE} --locked`,
            detail: 'espup downloads and manages the Xtensa toolchain. Compiling it takes a few minutes.',
        });
    }

    if (missing.includes('toolchain')) {
        const targets = chips.length > 0 ? chips.join(',') : 'esp32,esp32s3';
        steps.push({
            id: 'toolchain',
            label: 'Install the Xtensa toolchain',
            command: `${ESPUP_CRATE} install --targets ${targets}`,
            detail: `Installs Espressif's rustc fork as the "${ESP_TOOLCHAIN_NAME}" toolchain and writes ~/${EXPORT_ESP_FILE}. Several hundred MB.`,
        });
    }

    if (missing.includes('espflash')) {
        steps.push({
            id: 'espflash',
            label: 'Install espflash',
            command: `cargo install ${ESPFLASH_CRATE} --locked`,
            detail: 'espflash writes the image over USB serial and can follow the log.',
        });
    }

    return steps;
}

/** One command line that runs every step, so the terminal shows what is happening. */
export function espInstallCommandLine(steps: EspInstallStep[]): string {
    return steps.map((step) => step.command).join(' && ');
}

/** True when `rustup toolchain list` shows the espup-installed toolchain. */
export function parseToolchainList(stdout: string, name: string = ESP_TOOLCHAIN_NAME): boolean {
    return stdout
        .split('\n')
        .map((line) => line.trim())
        .some((line) => line === name || line.startsWith(`${name}-`) || line.startsWith(`${name} `));
}

/** The file `espup install` writes on Windows; same content, PowerShell syntax. */
export const EXPORT_ESP_PS1 = 'export-esp.ps1';

/**
 * Both names espup is known to write, in the order they are worth reading. Whichever exists is used;
 * a machine can only have the one its platform asks for.
 */
export const EXPORT_ESP_FILES = [EXPORT_ESP_FILE, EXPORT_ESP_PS1] as const;

export interface ExportEspEnv {
    /** Non-PATH variables, expanded and verbatim (`LIBCLANG_PATH`, ...). */
    vars: Record<string, string>;
    /** Directories to put in front of PATH, in file order. */
    pathPrepend: string[];
}

/**
 * Read `export-esp.ps1`, the Windows half of the same idea.
 *
 * The lines assign through PowerShell's environment provider instead of `export`:
 *
 *     $env:LIBCLANG_PATH = "C:\Users\me\AppData\Local\esp\esp-rs\llvm\...\lib"
 *     $env:PATH = "C:\...\riscv32-esp-elf\bin;C:\...\xtensa-esp32-elf\bin;" + $env:PATH
 *
 * so the value is the first quoted string on the line, and a PATH assignment's own segments are
 * the ones being *prepended* -- the `+ $env:PATH` tail is the machine's existing PATH and is left
 * for `withExportEspEnv` to keep. Separators are `;` on Windows. Tolerant on purpose: an unknown
 * line is skipped rather than making the rest of the file unreadable.
 */
export function parseExportEspPowerShell(content: string, home?: string): ExportEspEnv {
    const vars: Record<string, string> = {};
    const pathPrepend: string[] = [];

    const expand = (value: string): string => {
        if (home === undefined) {
            return value;
        }
        return value
            .replace(/\$env:USERPROFILE/gi, home)
            .replace(/\$env:HOME/gi, home)
            .replace(/\$HOME/gi, home);
    };

    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) {
            continue;
        }
        const match = /^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/i.exec(line);
        if (match === null) {
            continue;
        }
        const name = match[1] ?? '';
        const value = expand(match[2] ?? '');
        if (name === '') {
            continue;
        }

        if (name.toUpperCase() === 'PATH') {
            // Only the literals before the existing-PATH reference are ours to prepend.
            for (const quoted of value.match(/("[^"]*"|'[^']*')/g) ?? []) {
                const literal = quoted.slice(1, -1);
                for (const segment of literal.split(';')) {
                    const trimmed = segment.trim();
                    if (trimmed !== '' && !/\$env:PATH/i.test(trimmed)) {
                        pathPrepend.push(trimmed);
                    }
                }
            }
            continue;
        }

        const literal = /^("[^"]*"|'[^']*')/.exec(value.trim());
        vars[name] = literal === null ? value.trim() : literal[0].slice(1, -1);
    }

    return { vars, pathPrepend };
}

/**
 * Read whichever export file this machine has.
 *
 * Called with the file's *name*, so the caller does not have to branch on the platform: the parser
 * follows the syntax, and only one of the two files is ever written on a machine.
 */
export function parseExportEspFile(fileName: string, content: string, home?: string): ExportEspEnv {
    return fileName.toLowerCase().endsWith('.ps1')
        ? parseExportEspPowerShell(content, home)
        : parseExportEsp(content, home);
}


/**
 * Read `export-esp.sh`.
 *
 * The file is a flat list of `export NAME=value` lines. Sourcing it is not an option for a
 * process we spawn ourselves, so the variables are read here and applied to the environment of
 * the commands we run -- which is why a build started from the extension works even in a shell
 * that never sourced anything.
 */
export function parseExportEsp(content: string, home?: string): ExportEspEnv {
    const vars: Record<string, string> = {};
    const pathPrepend: string[] = [];

    const expand = (value: string): string =>
        home === undefined
            ? value
            : value.replace(/\$\{HOME\}/g, home).replace(/\$HOME/g, home);

    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('#')) {
            continue;
        }
        const match = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (!match) {
            continue;
        }
        const name = match[1] ?? '';
        const value = expand((match[2] ?? '').trim().replace(/^["']/, '').replace(/["']$/, ''));
        if (name === '') {
            continue;
        }

        if (name === 'PATH') {
            for (const segment of value.split(':')) {
                // `.../bin:$PATH` -- only what is being *prepended* is ours to add.
                if (segment !== '' && !segment.includes('$PATH')) {
                    pathPrepend.push(segment);
                }
            }
            continue;
        }
        vars[name] = value;
    }

    return { vars, pathPrepend };
}

/**
 * The environment a spawned command needs, given the machine's own.
 *
 * PATH is prepended rather than replaced: the Espressif linker has to win over any system
 * `xtensa-esp*-elf-gcc`, while cargo and rustup keep coming from where they always did.
 */
export function withExportEspEnv(
    base: Record<string, string>,
    exported: ExportEspEnv,
    delimiter = ':',
): Record<string, string> {
    const environment: Record<string, string> = { ...base, ...exported.vars };
    if (exported.pathPrepend.length > 0) {
        const existing = base.PATH ?? base.Path ?? '';
        environment.PATH = [...exported.pathPrepend, ...(existing === '' ? [] : [existing])].join(delimiter);
    }
    return environment;
}

/** A short line for the toolchain view. */
export function espToolchainSummary(status: EspToolchainStatus): string {
    // Derived from the same facts that decide readiness, so the two can never disagree -- a
    // "missing:" line with nothing after it is what made that worth fixing.
    const missing = missingEspPieces(status);
    if (missing.length > 0) {
        return `missing: ${missing.join(', ')}`;
    }
    const versions = [status.espup.version, status.espflash.version].filter(
        (version): version is string => version !== undefined && version !== '',
    );
    return versions.length === 0 ? 'ready' : `ready (${versions.join(', ')})`;
}
