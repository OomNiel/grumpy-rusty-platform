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

// ------------------------------------------------------- the debugger's own schema
//
// The four configurations a project is born with are written against the schema probe-rs-debugger
// published on the day they were written. That schema moves -- a key gets renamed, a nested object
// gains a shape -- and nothing warns: VS Code accepts a configuration with an unknown key, the
// debugger ignores it, and the session then behaves differently from what the file plainly says
// (the `flashingConfig.flashingEnabled` default is the canonical example, and the reason that
// comment exists in the generator).
//
// So the check is against the **installed** extension's own `contributes.debuggers`, not against a
// version table kept here: whatever that says is the truth on this machine, and it stays the truth
// when probe-rs is updated.

/** The debugger `type` a probe-rs configuration names. */
export const PROBE_RS_DEBUG_TYPE = 'probe-rs-debug';

/** What a debugger declares about one property of one request. */
export interface DebuggerPropertySchema {
    type?: string | readonly string[];
    enum?: readonly unknown[];
    description?: string;
    /** For an object-valued property: its own members. */
    properties?: Record<string, DebuggerPropertySchema>;
    required?: readonly string[];
    /** For an array-valued property: the schema each element has to satisfy. */
    items?: { properties?: Record<string, DebuggerPropertySchema>; required?: readonly string[] };
}

/** What a debugger declares for one `request` value (`launch`, `attach`). */
export interface DebuggerRequestSchema {
    properties?: Record<string, DebuggerPropertySchema>;
    required?: readonly string[];
}

/** The configuration schema a debugger extension publishes. */
export interface DebuggerSchema {
    /** The debugger's `type`, e.g. `probe-rs-debug`. */
    type: string;
    /** Per `request` value, when the extension splits them. An empty record means "no schema". */
    requests: Record<string, DebuggerRequestSchema>;
}

/**
 * Reads the schema out of a debugger extension's `package.json`.
 *
 * `undefined` means "nothing to check against": the extension declares no `contributes.debuggers`
 * entry of this type, or no `configurationAttributes` for it. That is a fact about the installed
 * extension, and the caller says so rather than reporting the file as fine.
 */
export function debuggerSchemaOf(
    packageJson: unknown,
    type: string = PROBE_RS_DEBUG_TYPE,
): DebuggerSchema | undefined {
    const contributes = (packageJson as { contributes?: { debuggers?: unknown } } | undefined)?.contributes;
    const debuggers = contributes?.debuggers;
    if (!Array.isArray(debuggers)) {
        return undefined;
    }
    const entry = debuggers.find((candidate) => (candidate as { type?: unknown }).type === type) as
        | { configurationAttributes?: unknown }
        | undefined;
    const attributes = entry?.configurationAttributes;
    if (typeof attributes !== 'object' || attributes === null) {
        return undefined;
    }

    const requests: Record<string, DebuggerRequestSchema> = {};
    for (const [request, schema] of Object.entries(attributes as Record<string, unknown>)) {
        const record = schema as { properties?: unknown; required?: unknown } | undefined;
        if (typeof record !== 'object' || record === null) {
            continue;
        }
        const properties: Record<string, DebuggerPropertySchema> = {};
        const declared = record.properties;
        if (typeof declared === 'object' && declared !== null) {
            for (const [name, property] of Object.entries(declared as Record<string, unknown>)) {
                properties[name] = (property ?? {}) as DebuggerPropertySchema;
            }
        }
        requests[request] = {
            properties,
            required: Array.isArray(record.required) ? record.required.filter((key) => typeof key === 'string') : [],
        };
    }

    return Object.keys(requests).length === 0 ? undefined : { type, requests };
}

/** The keys VS Code itself owns in every configuration; a debugger need not declare them. */
const VS_CODE_KEYS = new Set(['type', 'request', 'name', 'comment']);

/**
 * The known key that most looks like an unknown one, for the "did you mean" half of the message.
 *
 * Two shapes are worth catching: a *rename*, where most of the word survives (`serverArgs` against
 * `serverArguments`), and a *typo*, which is one or two edits away (`chiip`, `flashConfig` for
 * `flashingConfig`). A wrong guess costs nothing -- the sentence still says the key is unknown.
 */
export function closestSchemaKey(key: string, known: readonly string[]): string | undefined {
    const lowered = key.toLowerCase();
    let best: { name: string; score: number } | undefined;
    for (const candidate of known) {
        const other = candidate.toLowerCase();
        const distance = editDistance(lowered, other);
        // Longer names tolerate more edits; a two-letter slip in a short one is a different word.
        const limit = Math.max(2, Math.floor(other.length / 3));
        const score = distance <= limit ? 10 - distance : sharedPrefix(lowered, other) >= 4 ? 4 : 0;
        if (score > 0 && (best === undefined || score > best.score)) {
            best = { name: candidate, score };
        }
    }
    return best?.name;
}

/** Levenshtein distance, which is small here because both strings are key names. */
function editDistance(a: string, b: string): number {
    if (a === b) {
        return 0;
    }
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(
                (previous[j] ?? 0) + 1,
                (current[j - 1] ?? 0) + 1,
                (previous[j - 1] ?? 0) + cost,
            );
        }
        previous = current;
    }
    return previous[b.length] ?? 0;
}

function sharedPrefix(a: string, b: string): number {
    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) {
        shared += 1;
    }
    return shared;
}

/**
 * One configuration checked against the installed debugger, one sentence per problem.
 *
 * Nested objects are checked too, one or two levels down: `coreConfigs` is an array whose items
 * have their own required keys, and a rename in there (`rttEnabled`) changes what a session does
 * just as much as a top-level one does. The depth is capped because a schema is data, and data
 * from someone else's package.json should not be able to make this recurse forever.
 *
 * Reported, never repaired here: whether to rewrite `launch.json` is a decision for the command,
 * which knows whether the file holds anything the user wrote.
 */
export function validateLaunchConfiguration(
    configuration: Record<string, unknown>,
    schema: DebuggerSchema,
): string[] {
    const name = typeof configuration.name === 'string' && configuration.name !== '' ? configuration.name : '(unnamed)';
    const request = typeof configuration.request === 'string' ? configuration.request : '';
    const requestSchema = schema.requests[request];
    if (requestSchema === undefined) {
        return [
            `"${name}": the installed debugger has no "${request}" request ` +
                `(it declares ${Object.keys(schema.requests).join(', ')})`,
        ];
    }
    return validateAgainstProperties(configuration, requestSchema, `"${name}"`, 0, true);
}

/** The deepest level of a schema this will walk into. */
const MAX_SCHEMA_DEPTH = 3;

function validateAgainstProperties(
    value: Record<string, unknown>,
    schema: { properties?: Record<string, DebuggerPropertySchema>; required?: readonly string[] },
    label: string,
    depth: number,
    isRoot: boolean,
): string[] {
    const problems: string[] = [];
    const properties = schema.properties ?? {};
    const declared = Object.keys(properties);

    for (const key of Object.keys(value)) {
        if (isRoot && VS_CODE_KEYS.has(key)) {
            continue;
        }
        const propertySchema = properties[key];
        if (propertySchema === undefined) {
            const suggestion = closestSchemaKey(key, declared);
            problems.push(
                `${label} → "${key}": the installed debugger does not know this key` +
                    (suggestion === undefined
                        ? ', so it is ignored'
                        : ` -- did you mean "${suggestion}"? This one is ignored.`),
            );
            continue;
        }
        if (depth >= MAX_SCHEMA_DEPTH) {
            continue;
        }
        const nested = value[key];
        if (Array.isArray(nested) && propertySchema.items !== undefined) {
            nested.forEach((element, index) => {
                if (isRecord(element)) {
                    problems.push(
                        ...validateAgainstProperties(
                            element,
                            propertySchema.items ?? {},
                            `${label} → ${key}[${index}]`,
                            depth + 1,
                            false,
                        ),
                    );
                }
            });
        } else if (isRecord(nested) && propertySchema.properties !== undefined) {
            problems.push(
                ...validateAgainstProperties(nested, propertySchema, `${label} → ${key}`, depth + 1, false),
            );
        }
    }

    for (const key of schema.required ?? []) {
        if (value[key] === undefined) {
            problems.push(`${label}: "${key}" is required by the installed debugger and is missing`);
        }
    }
    return problems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every probe-rs configuration in a file, validated against the installed debugger.
 *
 * An empty array means "everything it declares is known and present" **or** "there is nothing here
 * to check": the caller distinguishes the two, because the second is not a clean bill of health.
 */
export function launchConfigProblems(
    launchJsonText: string,
    schema: DebuggerSchema | undefined,
): string[] {
    if (schema === undefined) {
        return [];
    }
    return probeRsConfigurations(launchJsonText).flatMap((configuration) =>
        validateLaunchConfiguration(configuration, schema),
    );
}

/** How many probe-rs configurations the file has, so the caller can tell "nothing to check" apart. */
export function probeRsConfigurationCount(launchJsonText: string): number {
    return probeRsConfigurations(launchJsonText).length;
}

/**
 * Whether regenerating the file would lose anything.
 *
 * True only when every configuration in it is one this generator produces (matched by name): then a
 * fresh file is the same set, updated, and the user's own entries are not there to lose. One foreign
 * debugger type, or one hand-written probe-rs configuration, and the answer is false -- the command
 * then reports and offers the file to look at instead of overwriting work.
 */
export function onlyGeneratedConfigurations(
    launchJsonText: string,
    generatedNames: readonly string[],
): boolean {
    const parsed = parseJsonc<{ configurations?: unknown }>(launchJsonText);
    const configurations = parsed?.configurations;
    if (!Array.isArray(configurations) || configurations.length === 0) {
        return false;
    }
    const known = new Set(generatedNames);
    return configurations.every((entry) => {
        const record = entry as { type?: unknown; name?: unknown } | undefined;
        return (
            record !== undefined &&
            record.type === PROBE_RS_DEBUG_TYPE &&
            typeof record.name === 'string' &&
            known.has(record.name)
        );
    });
}

/** The names of every configuration in a file, in order -- which is what a regeneration matches on. */
export function configurationNames(launchJsonText: string): string[] {
    const parsed = parseJsonc<{ configurations?: unknown }>(launchJsonText);
    const configurations = parsed?.configurations;
    if (!Array.isArray(configurations)) {
        return [];
    }
    return configurations
        .map((entry) => (entry as { name?: unknown } | undefined)?.name)
        .filter((name): name is string => typeof name === 'string' && name !== '');
}
