import * as vscode from 'vscode';
import * as path from 'path';
import { RustyState } from '../state';
import { ActiveProject } from '../project/activeProject';
import { makeWithProject } from './withProject';
import { CatalogEntry, catalogByCategory, docsUrlFor } from '../library/catalog';
import { applyDependency, parseCargoToml } from '../library/cargoToml';
import { CrateFeatureInfo, CrateSummary, fetchCrateFeatures, searchCrates } from '../library/registry';
import { httpGetText } from '../util/http';

/**
 * The crates.io Library Manager.
 *
 * One command, two roads into the catalog: the curated bundled list (pins verified against
 * the registry, features pre-ticked) or a live crates.io search for anything else. The
 * dependency is written into `Cargo.toml` by the pure editor in `library/cargoToml.ts` —
 * not by `cargo add` — so the change is reviewable and testable, and Cargo resolves it on
 * the next build.
 */

interface CrateChoice {
    entry?: CatalogEntry;
    summary?: CrateSummary;
    /** Set when the crate came from the live search rather than the bundled catalog. */
    fromSearch: boolean;
}

interface FeatureChoice extends vscode.QuickPickItem {
    feature: string;
}

/** One item in the crate picker; keeps the command id next to its label. */
interface CratePickItem extends vscode.QuickPickItem {
    choice?: CrateChoice;
    search?: boolean;
}

const SEARCH_LABEL = '$(search) Search crates.io…';

function formatDownloads(count: number | undefined): string | undefined {
    if (count === undefined) {
        return undefined;
    }
    if (count >= 1_000_000) {
        return `${Math.round(count / 100_000) / 10}M downloads`;
    }
    if (count >= 1_000) {
        return `${Math.round(count / 100) / 10}k downloads`;
    }
    return `${count} downloads`;
}

/** Crate picker: the bundled catalog first, then a live search escape hatch. */
async function pickCrate(project: ActiveProject): Promise<CrateChoice | undefined> {
    const model = parseCargoToml(project.cargoToml);
    const installed = new Set(model.dependencies.map((dependency) => dependency.name));

    const items: CratePickItem[] = [
        {
            label: SEARCH_LABEL,
            detail: 'Look a crate up on crates.io by name or keyword (no bundled pin, so the latest release is used).',
            alwaysShow: true,
            search: true,
        },
    ];

    for (const group of catalogByCategory()) {
        items.push({
            label: group.category.label,
            kind: vscode.QuickPickItemKind.Separator,
        });
        for (const entry of group.entries) {
            items.push({
                label: entry.name,
                description: installed.has(entry.name) ? `${entry.version} · in this project` : entry.version,
                detail: entry.note ? `${entry.summary} — ${entry.note}` : entry.summary,
                choice: { entry, fromSearch: false },
            });
        }
    }

    const picked = await vscode.window.showQuickPick(items, {
        title: "Grumpy's Rusty Platform — add a dependency",
        placeHolder: 'Crate to add to Cargo.toml',
        matchOnDetail: true,
        ignoreFocusOut: true,
    });
    if (!picked) {
        return undefined;
    }
    if (picked.search) {
        return searchForCrate();
    }
    return picked.choice;
}

async function searchForCrate(): Promise<CrateChoice | undefined> {
    const query = await vscode.window.showInputBox({
        title: 'Search crates.io',
        prompt: 'Crate name or keywords',
        placeHolder: 'e.g. ssd1306, or "temperature sensor"',
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() === '' ? 'Type something to search for.' : undefined),
    });
    if (!query) {
        return undefined;
    }

    let results: CrateSummary[];
    try {
        results = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Rusty Platform: searching crates.io for “${query.trim()}”…` },
            () => searchCrates(query, httpGetText),
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`crates.io search failed: ${message}`);
        return undefined;
    }

    if (results.length === 0) {
        void vscode.window.showInformationMessage(`crates.io has nothing matching “${query.trim()}”.`);
        return undefined;
    }

    const picked = await vscode.window.showQuickPick(
        results.map((summary) => ({
            label: summary.name,
            description: [summary.maxVersion, formatDownloads(summary.downloads)].filter(Boolean).join(' · '),
            detail: summary.description,
            summary,
        })),
        {
            title: `crates.io — ${results.length} result${results.length === 1 ? '' : 's'}`,
            placeHolder: 'Crate to add',
            matchOnDetail: true,
            ignoreFocusOut: true,
        },
    );
    return picked ? { summary: picked.summary, fromSearch: true } : undefined;
}

/** Ask which features to enable, pre-ticking the curated set when we have one. */
async function pickFeatures(
    name: string,
    version: string,
    features: string[],
    recommended: string[],
    notes: Map<string, string | undefined>,
): Promise<string[] | undefined> {
    if (features.length === 0) {
        return [];
    }
    const items: FeatureChoice[] = features.map((feature) => ({
        label: feature,
        description: recommended.includes(feature) ? 'recommended' : undefined,
        detail: notes.get(feature),
        picked: recommended.includes(feature),
        feature,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: `${name} ${version} — features`,
        placeHolder: 'Tick the features to enable, then press Enter (Esc or none = no extra features)',
        canPickMany: true,
        ignoreFocusOut: true,
    });
    return picked === undefined ? undefined : picked.map((item) => item.feature);
}

/** The last gate: the exact line, the file, and the reason it is being written. */
async function confirmWrite(
    action: 'added' | 'updated',
    line: string,
    project: ActiveProject,
    reason?: string,
): Promise<boolean> {
    const cargoTomlPath = path.join(project.folder.fsPath, 'Cargo.toml');
    const answer = await vscode.window.showWarningMessage(
        [
            `${action === 'added' ? 'Add' : 'Update'} this dependency in Cargo.toml?`,
            '',
            `  ${line}`,
            '',
            cargoTomlPath,
            ...(reason ? ['', reason] : []),
        ].join('\n'),
        { modal: true },
        action === 'added' ? 'Add' : 'Update',
    );
    return answer !== undefined;
}

export function registerLibraryCommands(state: RustyState, output: vscode.OutputChannel): vscode.Disposable[] {
    const withProject = makeWithProject(state, output);

    return [
        vscode.commands.registerCommand('rustyPlatform.addDependency', () =>
            withProject(async (project) => {
                const choice = await pickCrate(project);
                if (!choice) {
                    return;
                }

                const name = choice.entry?.name ?? choice.summary?.name;
                if (!name) {
                    return;
                }

                const model = parseCargoToml(project.cargoToml);
                const existing = model.dependencies.find((dependency) => dependency.name === name);

                // Never silently move a version the project already pins: an update keeps the
                // version that is there and only changes the feature set.
                let version = existing?.version ?? choice.entry?.version ?? choice.summary?.maxVersion;
                let features: string[];
                let recommended: string[];
                const notes = new Map<string, string | undefined>();

                if (choice.entry) {
                    const entry = choice.entry;
                    for (const feature of entry.features) {
                        notes.set(feature.name, feature.note);
                    }
                    const listed = entry.features.map((feature) => feature.name);
                    features = [
                        ...listed,
                        ...(entry.implicitFeatures ?? []).filter((feature) => !listed.includes(feature)),
                    ];
                    recommended = entry.recommended;
                } else {
                    // Live crate: ask the registry what Cargo will accept, and pre-tick nothing —
                    // guessing a feature set for a crate we have not curated is how projects break.
                    let info: CrateFeatureInfo;
                    try {
                        info = await vscode.window.withProgress(
                            { location: vscode.ProgressLocation.Notification, title: `Rusty Platform: reading ${name} from the crates.io index…` },
                            () => fetchCrateFeatures(name, httpGetText),
                        );
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        void vscode.window.showErrorMessage(`Could not read ${name} from crates.io: ${message}`);
                        return;
                    }
                    if (version === undefined) {
                        version = info.version;
                    }
                    features = info.features;
                    recommended = existing?.features ?? [];
                    if (info.implicitFeatures.length > 0) {
                        notes.set(
                            info.implicitFeatures[0]!,
                            'comes from an optional dependency, so it is absent from the index listing',
                        );
                    }
                }

                const picked = await pickFeatures(name, version ?? '(no version)', features, recommended, notes);
                if (picked === undefined) {
                    return;
                }

                const outcome = applyDependency(project.cargoToml, { name, version, features: picked });
                if (!outcome.ok) {
                    void vscode.window.showErrorMessage(`Cargo.toml was not changed: ${outcome.reason}`);
                    return;
                }

                const reason = existing
                    ? `This entry already exists; its version is kept and its features were replaced. Previous line: ${(existing.lines[0] ?? '').trim()}`
                    : undefined;
                if (!(await confirmWrite(outcome.action, outcome.line, project, reason))) {
                    return;
                }

                await vscode.workspace.fs.writeFile(
                    vscode.Uri.joinPath(project.folder, 'Cargo.toml'),
                    Buffer.from(outcome.text, 'utf8'),
                );
                output.appendLine(`${outcome.action} ${outcome.line} in ${path.join(project.folder.fsPath, 'Cargo.toml')}`);

                const docs = docsUrlFor(name, version);
                const next = await vscode.window.showInformationMessage(
                    `${name} ${outcome.action === 'added' ? 'added' : 'updated'}: ${outcome.line} ` +
                    'Cargo resolves it on the next build.',
                    'Open Cargo.toml',
                    'Docs',
                );
                if (next === 'Open Cargo.toml') {
                    await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(project.folder, 'Cargo.toml'));
                } else if (next === 'Docs') {
                    await vscode.env.openExternal(vscode.Uri.parse(docs));
                }
            }, 'edit'),
        ),

        // Clicking a dependency in the Project view lands on its line. Registered here rather
        // than in the view so the tree item only has to carry a uri and a line number.
        vscode.commands.registerCommand('rustyPlatform.revealDependency', async (uri?: vscode.Uri, line?: number) => {
            if (!uri || typeof line !== 'number') {
                return;
            }
            const document = await vscode.workspace.openTextDocument(uri);
            const range = new vscode.Range(line, 0, line, 0);
            await vscode.window.showTextDocument(document, { selection: range });
        }),
    ];
}
