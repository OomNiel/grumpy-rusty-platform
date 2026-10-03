/**
 * Reading a project's `.vscode/launch.json`.
 *
 * `vscode`-free so the t1 layer can test it against the file the generator really writes.
 * The JSON is *jsonc*: VS Code allows `//` and `/* *​/` comments and trailing commas in this
 * file, and users do add them, so `JSON.parse` alone is not enough.
 */

export interface DebugConfigurationLike {
    name: string;
    type: string;
}

/** Strip comments and trailing commas, then parse. Returns `undefined` instead of throwing. */
export function parseJsonc<T>(text: string): T | undefined {
    let cleaned = '';
    let inString = false;
    let quote = '';

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index] ?? '';
        const next = text[index + 1] ?? '';

        if (inString) {
            cleaned += char;
            if (char === '\\') {
                cleaned += next;
                index += 1;
            } else if (char === quote) {
                inString = false;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            inString = true;
            quote = char;
            cleaned += char;
            continue;
        }

        if (char === '/' && next === '/') {
            while (index < text.length && text[index] !== '\n') {
                index += 1;
            }
            cleaned += '\n';
            continue;
        }

        if (char === '/' && next === '*') {
            index += 2;
            while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
                index += 1;
            }
            index += 1;
            continue;
        }

        cleaned += char;
    }

    // A comma immediately before a closing brace/bracket is the other jsonc extension.
    cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

    try {
        return JSON.parse(cleaned) as T;
    } catch {
        return undefined;
    }
}

/** A `probe-rs*` configuration, as the Debug command and the picker need it. */
export interface DebugChoice {
    name: string;
    /** One line for the picker: what this configuration will do to the chip. */
    detail: string;
    /** Which build the configuration's `programBinary` points at, when it can be told. */
    profile?: BuildProfile;
    /** The `programBinary` as written in launch.json, relative to the project folder. */
    binary?: string;
    /** Whether the session writes the chip (a `launch` configuration) or only reads it. */
    flashing: boolean;
}

/** The two builds a project can hold: what the Debug button writes, and what Flash writes. */
export type BuildProfile = 'debug' | 'release';

/**
 * Workspace state key: which build this extension last flashed for the project. The attach entries
 * are only safe against a matching image, so the Debug command remembers what it wrote.
 */
export const LAST_FLASHED_KEY = 'rustyPlatform.lastFlashedProfile';

/** A row of the Debug picker. */
export interface DebugPickerItem {
    label: string;
    /** Right-aligned grey text, e.g. "matches the last flash". */
    description?: string;
    detail: string;
    choice: DebugChoice;
}

interface ConfigurationRecord {
    [key: string]: unknown;
    name?: unknown;
    type?: unknown;
}

/**
 * Every `probe-rs*` configuration, in file order. Matched by type prefix so `probe-rs-debug` and any
 * future `probe-rs-…` type both work; entries without a usable name are ignored.
 */
function probeRsConfigurations(launchJsonText: string): ConfigurationRecord[] {
    const parsed = parseJsonc<{ configurations?: unknown }>(launchJsonText);
    const configurations = parsed?.configurations;
    if (!Array.isArray(configurations)) {
        return [];
    }
    return configurations.filter((entry): entry is ConfigurationRecord => {
        const record = entry as ConfigurationRecord | undefined;
        return (
            record !== undefined &&
            typeof record.type === 'string' &&
            record.type.startsWith('probe-rs') &&
            typeof record.name === 'string' &&
            record.name.trim() !== ''
        );
    });
}

/**
 * The first `probe-rs*` launch configuration, which is what a one-click Debug starts.
 */
export function findProbeRsDebugConfiguration(launchJsonText: string): DebugConfigurationLike | undefined {
    const first = probeRsConfigurations(launchJsonText)[0];
    if (first === undefined) {
        return undefined;
    }
    return { name: first.name as string, type: first.type as string };
}

/**
 * What a configuration does to the chip, in the words the picker shows.
 *
 * `flashingConfig.flashingEnabled` defaults to *false* in probe-rs-debugger, and a session that does
 * not flash decodes RTT with whatever ELF it was given — so the description has to say plainly
 * whether the chip is written and whether anything stops.
 */
export function describeDebugConfiguration(configuration: ConfigurationRecord): DebugChoice {
    const name = configuration.name as string;
    const flashing = configuration.flashingConfig as
        | { flashingEnabled?: unknown; haltAfterReset?: unknown }
        | undefined;
    const binary = binaryOf(configuration);
    const profile = profileFromBinary(binary);

    if (flashing?.flashingEnabled !== true) {
        const build = profile === undefined ? 'build' : `${profile} build`;
        if (configuration.request === 'attach') {
            return {
                name,
                profile,
                binary,
                flashing: false,
                // An attach session joins a program that is already running, and probe-rs refuses the
                // flashing options (including `halt_after_reset`) for an `attach` request, so nothing
                // can reset it: code that has already executed can never be reached again. Measured on
                // the bench 2026-10-03: a breakpoint in the blink loop binds at once, one in the boot
                // marker or the Wi-Fi setup never does. Saying which is which is the difference
                // between the user understanding that and blaming the debugger.
                detail:
                    profile === 'release'
                        ? `no flashing, no reset: joins the running program and debugs the optimised ${build} - some breakpoints cannot bind at all`
                        : 'no flashing, no reset: joins the running program - breakpoints only bind in code that runs again (a loop, an interrupt)',
            };
        }
        return {
            name,
            profile,
            binary,
            flashing: false,
            // A `launch` with `flashingEnabled: false` writes nothing, but it still resets the target -
            // which is what lets a breakpoint in `main` or in startup code bind.
            detail:
                profile === 'release'
                    ? `no flashing: restarts the chip from reset and debugs the optimised ${build} - some breakpoints cannot bind`
                    : `no flashing: restarts the chip from reset, so breakpoints bind anywhere - the ${build} already on the chip is kept`,
        };
    }
    if (flashing.haltAfterReset === true) {
        return {
            name,
            profile,
            binary,
            flashing: true,
            detail: 'flashes the debug build, then halts on the reset vector',
        };
    }
    return {
        name,
        profile,
        binary,
        flashing: true,
        detail: 'flashes the debug build, then runs and stops at your breakpoints',
    };
}

/** The `programBinary` a configuration names, as written in launch.json. */
function binaryOf(configuration: ConfigurationRecord): string | undefined {
    const coreConfigs = configuration.coreConfigs;
    if (!Array.isArray(coreConfigs)) {
        return undefined;
    }
    const binary = (coreConfigs[0] as { programBinary?: unknown } | undefined)?.programBinary;
    return typeof binary === 'string' && binary.trim() !== '' ? binary : undefined;
}

/**
 * Which build a `programBinary` path names. Both separators are accepted, because a hand-written
 * launch.json on Windows says `target\\thumbv8m.main-none-eabihf\\debug\\app`.
 */
function profileFromBinary(binary: string | undefined): BuildProfile | undefined {
    if (binary === undefined) {
        return undefined;
    }
    if (/[\\/]debug[\\/]/.test(binary)) {
        return 'debug';
    }
    return /[\\/]release[\\/]/.test(binary) ? 'release' : undefined;
}

/**
 * What the picker should show, with the chip's actual contents taken into account.
 *
 * An attach session cannot repair a mismatched build (it never flashes), and the failure is silent:
 * breakpoints address code that is not on the chip and defmt decodes against the wrong string table.
 * So the entry that matches the last flash says so, and the other one says what the chip holds.
 */
export function debugPickerItems(
    launchJsonText: string,
    lastFlashed?: BuildProfile,
): DebugPickerItem[] {
    return debugConfigurationChoices(launchJsonText).map((choice) => {
        if (choice.flashing || choice.profile === undefined || lastFlashed === undefined) {
            return { label: choice.name, detail: choice.detail, choice };
        }
        const matches = choice.profile === lastFlashed;
        return {
            label: choice.name,
            // An attach session can only work against the build it expects; saying what the chip
            // actually holds is what keeps this from failing silently.
            description: matches ? 'matches the last flash' : `the chip holds the ${lastFlashed} build`,
            detail: choice.detail,
            choice,
        };
    });
}

/**
 * True when this choice expects a build other than the one the chip should be holding. Only attach
 * sessions can suffer from it; a `launch` configuration writes the build it debugs.
 */
export function profileMismatch(choice: DebugChoice, lastFlashed?: BuildProfile): boolean {
    if (choice.flashing || choice.profile === undefined || lastFlashed === undefined) {
        return false;
    }
    return choice.profile !== lastFlashed;
}

/** The configurations a project offers, ready for a QuickPick. */
export function debugConfigurationChoices(launchJsonText: string): DebugChoice[] {
    return probeRsConfigurations(launchJsonText).map(describeDebugConfiguration);
}

/** The extension that must be installed for such a configuration to run. */
export const PROBE_RS_DEBUGGER_EXTENSION = 'probe-rs.probe-rs-debugger';

/**
 * Which session a "stop" action should target: the active one when it is ours, otherwise the
 * first probe-rs session that is still running. Keeping this here (rather than inline in the
 * command) means the choice is covered by the t1 layer.
 */
export function pickProbeRsSession<T extends { type: string }>(
    sessions: readonly T[],
    active?: T,
): T | undefined {
    if (active !== undefined && active.type.startsWith('probe-rs')) {
        return active;
    }
    return sessions.find((session) => session.type.startsWith('probe-rs'));
}
