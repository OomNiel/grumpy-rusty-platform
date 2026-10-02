/**
 * Finding the artefact cargo actually produced, from its JSON message stream.
 *
 * Why not just guess `target/<triple>/release/<name>`: that breaks the moment a project sets
 * `CARGO_TARGET_DIR`, a custom `target-dir` in `.cargo/config.toml`, or a workspace layout.
 * Cargo already knows the answer, so we ask it with `--message-format=json` and read the
 * `executable` field.
 */

export interface CargoArtifact {
    /** Absolute path to the linked binary, when the target is a binary. */
    executable?: string;
    /** The target name, e.g. the crate name. */
    targetName?: string;
    packageName?: string;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * One line of cargo's stdout. Returns undefined for anything that is not a usable artifact
 * message, so callers can walk the stream without special-casing diagnostics or build
 * scripts (those arrive on stderr when `json-render-diagnostics` is used, but we tolerate
 * them anyway).
 */
export function parseCargoArtifact(line: string): CargoArtifact | undefined {
    const text = line.trim();
    if (text === '' || !text.startsWith('{')) {
        return undefined;
    }

    let message: unknown;
    try {
        message = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof message !== 'object' || message === null) {
        return undefined;
    }

    const record = message as Record<string, unknown>;
    if (record.reason !== 'compiler-artifact') {
        return undefined;
    }
    const target = typeof record.target === 'object' && record.target !== null
        ? (record.target as Record<string, unknown>)
        : undefined;

    return {
        executable: asString(record.executable),
        targetName: asString(target?.name),
        packageName: asString(record.package_id),
    };
}

/**
 * The last binary cargo reported. "Last" because a rebuild may emit several messages for the
 * same target, and the final one reflects the current run.
 */
export function findElfArtifactPath(stdout: string): string | undefined {
    let found: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
        const artifact = parseCargoArtifact(line);
        if (artifact?.executable && !artifact.executable.endsWith('.d')) {
            found = artifact.executable;
        }
    }
    return found;
}
