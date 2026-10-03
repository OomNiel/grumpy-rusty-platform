/**
 * crates.io client for the Library Manager — the "live search" half.
 *
 * Two registry surfaces are used, and they are not interchangeable:
 *
 *  - **search** — `https://crates.io/api/v1/crates?q=…` returns JSON with a human
 *    description. The sparse index cannot search: it is keyed by name only.
 *  - **features** — the sparse index, one JSON document per line per published version.
 *    Only the index is authoritative for feature names, and reading it means merging
 *    `features` with `features2` (NOTES.md 2.3).
 *
 * Everything that turns bytes into data is a pure function, so the t1 layer can test the
 * parsing without a network. The two `fetch…` helpers take an injected HTTP function.
 */

import { HttpGetText } from '../util/http';

export interface IndexDependency {
    name: string;
    /** Cargo.toml key when the dependency is renamed; otherwise absent. */
    explicit_name_in_toml?: string;
    req: string;
    optional?: boolean;
    kind?: string | null;
}

export interface IndexVersion {
    vers: string;
    yanked?: boolean;
    features?: Record<string, string[]>;
    features2?: Record<string, string[]>;
    deps?: IndexDependency[];
    rust_version?: string;
}

export interface CrateSummary {
    name: string;
    maxVersion?: string;
    description: string;
    downloads?: number;
    /** Set when the crate has a newer release that is a pre-release. */
    newestVersion?: string;
    updatedAt?: string;
}

export interface CrateFeatureInfo {
    name: string;
    version: string;
    /** Every feature name Cargo will accept for `version`. */
    features: string[];
    /** The subset that comes from an optional dependency rather than `[features]`. */
    implicitFeatures: string[];
    /** Other published versions, newest first — an escape hatch for the picker. */
    otherVersions: string[];
}

/** Sparse-index path for a crate name, per the registry's layout. */
export function indexPathFor(name: string): string {
    const lowered = name.trim().toLowerCase();
    if (lowered.length === 0) {
        throw new Error('A crate name is required.');
    }
    if (lowered.length === 1) {
        return `1/${lowered}`;
    }
    if (lowered.length === 2) {
        return `2/${lowered}`;
    }
    if (lowered.length === 3) {
        return `3/${lowered[0]}/${lowered}`;
    }
    return `${lowered.slice(0, 2)}/${lowered.slice(2, 4)}/${lowered}`;
}

/** The sparse-index text is newline-delimited JSON; bad lines are skipped, not fatal. */
export function parseIndexEntries(text: string): IndexVersion[] {
    const versions: IndexVersion[] = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') {
            continue;
        }
        try {
            const parsed = JSON.parse(trimmed) as IndexVersion;
            if (parsed && typeof parsed.vers === 'string') {
                versions.push(parsed);
            }
        } catch {
            // A truncated or unexpected line simply does not count as a version.
        }
    }
    return versions;
}

interface ParsedVersion {
    parts: number[];
    prerelease: string | undefined;
}

function parseVersion(version: string): ParsedVersion | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
    if (!match) {
        return undefined;
    }
    return {
        parts: [Number(match[1]), Number(match[2]), Number(match[3])],
        prerelease: match[4],
    };
}

/** Semver ordering for the release triple; anything unparseable sorts last. */
export function compareVersions(left: string, right: string): number {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) {
        return left.localeCompare(right);
    }
    for (let index = 0; index < 3; index += 1) {
        const left_ = a.parts[index] ?? 0;
        const right_ = b.parts[index] ?? 0;
        if (left_ !== right_) {
            return left_ - right_;
        }
    }
    if (a.prerelease === b.prerelease) {
        return 0;
    }
    if (a.prerelease === undefined) {
        return 1;
    }
    if (b.prerelease === undefined) {
        return -1;
    }
    return a.prerelease.localeCompare(b.prerelease);
}

/**
 * Newest release Cargo would pick: yanked versions are out, and pre-releases only win when
 * they are all there is.
 */
export function latestVersion(versions: IndexVersion[]): IndexVersion | undefined {
    const live = versions.filter((version) => !version.yanked);
    const stable = live.filter((version) => parseVersion(version.vers)?.prerelease === undefined);
    const pool = stable.length > 0 ? stable : live;
    return [...pool].sort((a, b) => compareVersions(a.vers, b.vers)).pop();
}

/**
 * Feature names Cargo accepts for one version.
 *
 * `features` and `features2` are merged (NOTES.md 2.3), and then the **implicit** features
 * Cargo creates for optional dependencies are added: the index reports only the manifest's
 * `[features]` table, so a crate whose feature is really an optional dependency of the same
 * name looks featureless here. portable-atomic is the proof — `cargo metadata` reports a
 * `critical-section` and a `serde` feature, the index reports neither.
 *
 * An optional dependency does *not* get an implicit feature when some feature enables it
 * with `dep:<name>` syntax; Cargo suppresses it, and offering it would produce a Cargo.toml
 * that fails to build.
 */
export function featureNamesFor(version: IndexVersion): { features: string[]; implicit: string[] } {
    const merged = { ...(version.features ?? {}), ...(version.features2 ?? {}) };
    const names = new Set<string>(Object.keys(merged));

    const suppressed = new Set<string>();
    for (const value of Object.values(merged)) {
        for (const item of value ?? []) {
            const match = /^dep:(.+)$/.exec(item);
            if (match) {
                suppressed.add(match[1] ?? '');
            }
        }
    }

    const implicit: string[] = [];
    for (const dependency of version.deps ?? []) {
        if (!dependency.optional) {
            continue;
        }
        const featureName = dependency.explicit_name_in_toml ?? dependency.name;
        if (featureName === undefined || suppressed.has(dependency.name) || names.has(featureName)) {
            continue;
        }
        names.add(featureName);
        implicit.push(featureName);
    }

    return { features: [...names].sort(), implicit: implicit.sort() };
}

/** The crates.io search payload, defensively read. */
export function parseSearchResponse(payload: unknown, limit = 20): CrateSummary[] {
    const crates = (payload as { crates?: unknown })?.crates;
    if (!Array.isArray(crates)) {
        return [];
    }
    const summaries: CrateSummary[] = [];
    for (const item of crates) {
        const record = item as Record<string, unknown>;
        if (typeof record?.name !== 'string' || record.name === '') {
            continue;
        }
        summaries.push({
            name: record.name,
            maxVersion: typeof record.max_version === 'string' ? record.max_version : undefined,
            description: typeof record.description === 'string' ? record.description.trim() : '',
            downloads: typeof record.downloads === 'number' ? record.downloads : undefined,
            newestVersion: typeof record.newest_version === 'string' ? record.newest_version : undefined,
            updatedAt: typeof record.updated_at === 'string' ? record.updated_at : undefined,
        });
        if (summaries.length >= limit) {
            break;
        }
    }
    return summaries;
}

export const CRATES_INDEX_BASE = 'https://index.crates.io';
export const CRATES_API_BASE = 'https://crates.io/api/v1';

/** Fetch every published version of one crate from the sparse index. */
export async function fetchCrateVersions(name: string, httpGet: HttpGetText): Promise<IndexVersion[]> {
    const url = `${CRATES_INDEX_BASE}/${indexPathFor(name)}`;
    const response = await httpGet(url);
    if (response.status === 404) {
        throw new Error(`No crate named "${name}" on crates.io.`);
    }
    if (response.status !== 200) {
        throw new Error(`crates.io returned HTTP ${response.status} for ${name}.`);
    }
    return parseIndexEntries(response.body);
}

/** The feature set (plus version list) the picker offers for a crate. */
export async function fetchCrateFeatures(name: string, httpGet: HttpGetText): Promise<CrateFeatureInfo> {
    const versions = await fetchCrateVersions(name, httpGet);
    const latest = latestVersion(versions);
    if (!latest) {
        throw new Error(`"${name}" has no published release on crates.io.`);
    }
    const { features, implicit } = featureNamesFor(latest);
    const others = [...versions]
        .filter((version) => !version.yanked && version.vers !== latest.vers)
        .map((version) => version.vers)
        .sort((a, b) => compareVersions(b, a));
    return { name, version: latest.vers, features, implicitFeatures: implicit, otherVersions: others };
}

/** Search crates.io by name or keyword. */
export async function searchCrates(query: string, httpGet: HttpGetText, limit = 20): Promise<CrateSummary[]> {
    const trimmed = query.trim();
    if (trimmed === '') {
        return [];
    }
    const url = `${CRATES_API_BASE}/crates?q=${encodeURIComponent(trimmed)}&per_page=${Math.max(1, Math.min(limit, 50))}`;
    const response = await httpGet(url);
    if (response.status !== 200) {
        throw new Error(`crates.io search returned HTTP ${response.status}.`);
    }
    try {
        return parseSearchResponse(JSON.parse(response.body) as unknown, limit);
    } catch {
        throw new Error('crates.io search returned something that was not JSON.');
    }
}
