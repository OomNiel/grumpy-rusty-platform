import * as vscode from 'vscode';
import { RustyState } from '../state';
import { ActiveProject, readActiveProject } from '../project/activeProject';
import { planProjectSetup } from '../toolchain/installPlan';
import { runInstallPlan } from '../toolchain/installRunner';

/**
 * What the caller is about to do. This decides what has to be installed first: a build
 * needs cargo and this project's target, a monitor session also needs probe-rs, and editing
 * Cargo.toml needs nothing at all.
 */
export type ProjectPurpose = 'build' | 'monitor' | 'edit';

/**
 * Asks for one confirmation, then installs whatever this project is missing.
 *
 * The prompt exists because installing a toolchain downloads hundreds of megabytes and
 * writes outside the workspace; the "automatically" part is that a single yes runs the
 * whole plan, re-detects, and lets the original command continue.
 */
async function ensureSetup(
    state: RustyState,
    output: vscode.OutputChannel,
    project: ActiveProject,
    purpose: Exclude<ProjectPurpose, 'edit'>,
): Promise<boolean> {
    const before = state.status ?? (await state.refresh());
    const target = project.board?.target;
    const needsProbeRs = purpose === 'monitor' && project.board?.kind !== 'esp';
    const steps = planProjectSetup(before, {
        targets: target === undefined ? [] : [target],
        platform: process.platform,
        arch: process.arch,
        // probe-rs is only ever part of the Raspberry Pi route: an ESP project is built and monitored
        // with espup's toolchain and `espflash`, so a missing probe-rs must not stand in the way of
        // Monitor there (2026-10-05).
        needsProbeRs,
    });
    if (steps.length === 0) {
        return true;
    }

    const listing = steps
        .map((step, index) => `${index + 1}. ${step.title}${step.requiresElevation ? '  (asks for your password)' : ''}`)
        .join('\n');
    const why = !before.cargo.found
        ? 'cargo and rustc are not installed.'
        : !before.probeRs.found && needsProbeRs
            ? 'probe-rs is not installed.'
            : `the ${target} target is not installed for this project.`;
    const confirmed = await vscode.window.showWarningMessage(
        `${why}\n\nRusty Platform can install:\n\n${listing}\n\nInstall now, then continue?`,
        { modal: true },
        'Install',
    );
    if (confirmed !== 'Install') {
        output.appendLine(`setup declined — ${purpose} was not started`);
        return false;
    }

    try {
        await runInstallPlan({ output }, steps, process.arch);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`setup failed: ${message}`);
        output.show(true);
        void vscode.window.showErrorMessage(`Setup did not finish: ${message.split('\n')[0]}`, 'Show Log');
        return false;
    }

    const after = await state.refresh();
    if (!after.cargo.found) {
        void vscode.window.showErrorMessage(
            'cargo is still not found after the installation, so the command was not started. ' +
            'Check the Rusty Platform output for what happened.',
        );
        return false;
    }
    if (target !== undefined && !after.installedTargets.includes(target)) {
        // Not fatal: the generated rust-toolchain.toml makes rustup fetch the target on the
        // first build. Say so rather than blocking the build.
        output.appendLine(`${target} is still not listed as installed; cargo will fetch it via rust-toolchain.toml.`);
    }
    return true;
}

/**
 * Wraps a command body that needs a ready project.
 *
 * Shared by the build/flash/monitor commands and the Library Manager, so every entry point
 * answers the same way when the workspace holds no project — and offers the same next step
 * instead of failing silently.
 */
export function makeWithProject(
    state: RustyState,
    output: vscode.OutputChannel,
): (run: (project: ActiveProject) => void | Promise<void>, purpose?: ProjectPurpose) => Promise<void> {
    return async (run, purpose = 'build') => {
        const project = await readActiveProject();
        if (!project) {
            const choice = await vscode.window.showWarningMessage(
                'No Rusty Platform project found in this workspace.',
                'New Project…',
            );
            if (choice === 'New Project…') {
                await vscode.commands.executeCommand('rustyPlatform.newProject');
            }
            return;
        }

        if (purpose !== 'edit' && !(await ensureSetup(state, output, project, purpose))) {
            return;
        }

        await run(project);
    };
}
