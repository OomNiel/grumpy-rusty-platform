import type { ToolchainStatus } from '../toolchain/detect';

/**
 * The one-click controls, defined once and shown twice: in the status bar and in the sidebar's
 * "Controls" section. Keeping the list here rather than in either view is what stops the two from
 * drifting apart — the status bar used to be the only copy.
 *
 * No `vscode` import, so the t1 layer can hold the list against the manifest.
 */

export interface ControlDescriptor {
    /** Command to run when the control is clicked. */
    command: string;
    /** Codicon name without the `$(…)` wrapper: the status bar embeds it, the tree shows it as an icon. */
    icon: string;
    /** Caption: the status-bar text and the tree label. */
    label: string;
    /** One line of grey text beside the tree label. */
    detail: string;
    /** Fuller explanation, for the tooltip. */
    tooltip: string;
    /** Meaningful only while a probe-rs session is running (the Stop control). */
    sessionOnly?: boolean;
}

/** The health readout: a status-bar item, and the first row of the sidebar section. */
export interface HealthSummary {
    icon: string;
    label: string;
    detail: string;
    markdown: string;
}

export const HEALTH_CONTROL: ControlDescriptor = {
    command: 'rustyPlatform.checkToolchain',
    icon: 'chip',
    label: 'Rusty',
    detail: 'check the toolchain',
    tooltip: 'Check the Rust toolchain',
};

/** In status-bar order; the sidebar section renders the same list in the same order. */
const ACTIONS: readonly ControlDescriptor[] = [
    {
        command: 'rustyPlatform.build',
        icon: 'tools',
        label: 'Build',
        detail: 'cargo build',
        tooltip: 'cargo build',
    },
    {
        command: 'rustyPlatform.flash',
        icon: 'zap',
        label: 'Flash',
        detail: 'write the board',
        tooltip: 'Flash the board (probe, or USB when no probe is usable)',
    },
    {
        command: 'rustyPlatform.debug',
        icon: 'debug-alt',
        label: 'Debug',
        detail: 'build, flash, debug',
        tooltip: 'Build, flash and start a probe-rs debug session with RTT',
    },
    {
        command: 'rustyPlatform.debugStop',
        icon: 'debug-stop',
        label: 'Debug Stop',
        detail: 'stop the running session',
        tooltip: 'Stop the running probe-rs debug session',
        sessionOnly: true,
    },
    {
        command: 'rustyPlatform.monitor',
        icon: 'output',
        label: 'Monitor',
        detail: 'defmt over RTT',
        tooltip: 'probe-rs attach — defmt output without flashing',
    },
    {
        command: 'rustyPlatform.clean',
        icon: 'trash',
        label: 'Clean',
        detail: 'cargo clean',
        tooltip: 'cargo clean (removes target/)',
    },
];

/** The health control first, then the actions. */
export const CONTROLS: readonly ControlDescriptor[] = [HEALTH_CONTROL, ...ACTIONS];

/** How a status bar item spells a control: the codicon, then the label. */
export function iconText(icon: string, label: string): string {
    return `$(${icon}) ${label}`;
}

/** Status-bar caption of a control, e.g. `$(tools) Build`. */
export function statusBarText(control: ControlDescriptor): string {
    return iconText(control.icon, control.label);
}

/**
 * The controls that apply right now. Stop is left out unless a probe-rs session is running: it is
 * only meaningful then, and another debugger's session is not ours to kill.
 */
export function visibleControls(sessionRunning: boolean): ControlDescriptor[] {
    return CONTROLS.filter((control) => control.sessionOnly !== true || sessionRunning);
}

/** Caption, one-line detail and tooltip of the health control, for a given toolchain status. */
export function healthSummary(status: ToolchainStatus | undefined): HealthSummary {
    if (status === undefined) {
        return {
            icon: 'chip',
            label: 'Rusty: detecting…',
            detail: 'detecting…',
            markdown: 'Detecting the Rust toolchain…',
        };
    }

    if (status.ready) {
        const probe = status.probes[0]?.name ?? 'none';
        return {
            icon: 'chip',
            label: 'Rusty: ready',
            detail: `cargo ${status.cargo.version ?? '?'} · probe-rs ${status.probeRs.version ?? '?'}`,
            markdown: [
                `**cargo** ${status.cargo.version ?? '?'}`,
                `**probe-rs** ${status.probeRs.version ?? '?'}`,
                `**targets** ${status.installedTargets.filter((t) => t !== 'x86_64-unknown-linux-gnu').join(', ')}`,
                `**probe** ${probe} — ${status.probeDiagnosis.message}`,
            ].join('  \n'),
        };
    }

    const problems = [
        status.cargo.found ? undefined : 'cargo is not installed',
        status.probeRs.found ? undefined : 'probe-rs is not installed',
        status.missingTargets.length > 0 ? `missing targets: ${status.missingTargets.join(', ')}` : undefined,
        status.probeDiagnosis.kind === 'ok' ? undefined : status.probeDiagnosis.message,
    ].filter((line): line is string => Boolean(line));

    return {
        icon: 'warning',
        label: 'Rusty: setup needed',
        detail: problems[0] ?? 'setup needed',
        markdown: problems.join('  \n'),
    };
}
