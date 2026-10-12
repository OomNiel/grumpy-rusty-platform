import type { ToolchainStatus } from '../toolchain/detect';
import type { EspToolchainStatus } from '../toolchain/espToolchain';
import { espToolchainSummary } from '../toolchain/espToolchain';
import { HealthFamily, healthReport } from '../toolchain/health';

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

/**
 * Starting a project, as a row in the Controls section.
 *
 * It was only ever an icon in the Boards view's title bar, which is a strange place to look for "make me a
 * project" when the Controls section is where every other action lives. Sidebar only: the status bar has six
 * rows and adding a seventh that most sessions use once would crowd the ones used constantly.
 *
 * The command itself is the wizard that has always been there -- board from the catalog, then template, then
 * name -- so this is a second door onto one routine rather than a second routine.
 */
export const NEW_PROJECT_CONTROL: ControlDescriptor = {
    command: 'rustyPlatform.newProject',
    icon: 'new-folder',
    label: 'New Project',
    detail: 'pick a board, then a template',
    tooltip: 'Asks which of the supported boards this is for (the whole catalog is listed, with your default '
        + 'board first), then which template, then the project name, and writes the workspace.',
};

/**
 * Opening the designer, at the top of the Controls section.
 *
 * The designer is a webview panel with a palette command (`rustyPlatform.openDesigner`) that until now had one
 * button in the interface -- a title-bar icon on the Project view, which is not where anyone looks for a
 * command. The Controls section is where every other action lives, so the command gets a row there too.
 *
 * The row runs that command rather than opening the panel itself: one implementation behind both doors, and the
 * question it asks when no project is open is asked once.
 */
export const OPEN_DESIGNER_CONTROL: ControlDescriptor = {
    command: 'rustyPlatform.openDesigner',
    icon: 'paintcan',
    label: 'Open Designer',
    detail: 'the canvas, Toolbox and properties',
    tooltip: 'Open the designer for the project that is open: the canvas, the Toolbox and the properties. The '
        + 'same as Open Designer in the Command Palette.',
};

/** In status-bar order; the sidebar section renders the same list in the same order. */
export const ACTION_CONTROLS: readonly ControlDescriptor[] = [
    {
        // The two builds the user asked for (2026-10-06): the debug one is what a probe-rs session can
        // step through, the release one is what a finished device runs. The single "Build" and the
        // "Debug" row are gone from the controls; `rustyPlatform.debug` stays in the palette, because on
        // an ESP board it is the only button that flashes *and* follows the log in one terminal.
        command: 'rustyPlatform.buildDebug',
        icon: 'tools',
        label: 'Build for Debug',
        detail: 'cargo build',
        tooltip: 'cargo build - the debug profile, the build a probe-rs session can step through.',
    },
    {
        command: 'rustyPlatform.buildRelease',
        icon: 'rocket',
        label: 'Build for Release',
        detail: 'cargo build --release',
        tooltip: 'cargo build --release - optimised, and what a finished device wants. This is the profile '
            + 'Flash writes for an ESP board.',
    },
    {
        command: 'rustyPlatform.flash',
        icon: 'zap',
        label: 'Flash',
        detail: 'write the board',
        tooltip: 'Flash the board (probe, or USB when no probe is usable)',
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
/** The packaging pair (asked 2026-10-05): publish the project as a `.deb`, then install it here. */
export const PACKAGE_CONTROLS: readonly ControlDescriptor[] = [
    {
        command: 'rustyPlatform.publishDeb',
        icon: 'package',
        label: 'Publish .deb',
        detail: 'firmware + flash helper into the project root',
        tooltip: 'Builds the firmware for release and packs its artifacts with a <name>-flash helper into a '
            + '.deb in the project root. Install it on any Debian/Ubuntu host to flash the board from there.'
    },
    {
        command: 'rustyPlatform.backupProject',
        icon: 'archive',
        label: 'Back Up Project',
        detail: 'a dated copy in the parent folder',
        tooltip: 'Copies this project folder next to itself as "<folder>-<date>_<time>", leaving out target/ and '
            + 'other build output so the copy is the project rather than the compiler\'s leftovers. Nothing is '
            + 'overwritten: a second backup in the same second gets a "-2".'
    },
    {
        command: 'rustyPlatform.installDeb',
        icon: 'desktop-download',
        label: 'Install .deb',
        detail: 'dpkg -i on this machine (sudo)',
        tooltip: 'Shows what is inside the .deb this project published, then runs sudo dpkg -i in a terminal so '
            + 'you can type your password. Linux only.'
    }
];

/**
 * The two explicit build choices (asked 2026-10-05: *"There should be a switch option or an additional
 * control button. Something like 'Flash with debug profile' and 'Flash with release profile'"*).
 *
 * They override `rustyPlatform.flashProfile` for one flash, which is why they are buttons rather than a
 * toggle: the setting is the standing answer ("auto" by default), and these are the times a user knows
 * better. Both build and write, exactly like Flash — the profile is the only difference.
 *
 * Sidebar only, like the packaging controls, so the status bar keeps its six.
 */
export const FLASH_PROFILE_CONTROLS: readonly ControlDescriptor[] = [
    {
        command: 'rustyPlatform.flashDebug',
        icon: 'bug',
        label: 'Flash (debug)',
        detail: 'debug build, then flash',
        tooltip: 'Build the debug profile and write it. This is the build a probe-rs session can step '
            + 'through, and on a panel it is the slow one: the generated display screen takes tens of '
            + 'seconds to paint as a debug build against about 0.2 s as a release build.',
    },
    {
        command: 'rustyPlatform.flashRelease',
        icon: 'rocket',
        label: 'Flash (release)',
        detail: 'release build, then flash',
        tooltip: 'Build the release profile and write it. Optimised, so it is what a finished device '
            + 'wants and what a display needs to draw at speed — but breakpoints in a probe-rs session '
            + 'will be hollow, so use the debug profile when you intend to step.',
    },
];

/**
 * The status bar's controls, in order — the six that are about *running* the project.
 *
 * The packaging pair is deliberately **not** here: `CONTROLS` also lays out the status bar, and two more items
 * in it would crowd a strip that has to stay readable. They are rows in the Controls section, which is what the
 * request asked for (2026-10-05).
 */
export const CONTROLS: readonly ControlDescriptor[] = [HEALTH_CONTROL, ...ACTION_CONTROLS];

/** How a status bar item spells a control: the codicon, then the label. */
export function iconText(icon: string, label: string): string {
    return `$(${icon}) ${label}`;
}

/** Status-bar caption of a control, e.g. `$(tools) Build`. */
export function statusBarText(control: ControlDescriptor): string {
    return iconText(control.icon, control.label);
}

/**
 * Wording that changes with the silicon.
 *
 * Three of these controls describe a *route*, and the route is not the same on both families: Flash,
 * Debug and Monitor all say "probe" and "RTT" because they were written for Raspberry Pi, and on an ESP
 * project Monitor really runs `espflash monitor` while Debug really has no breakpoints at all. The
 * labels stay put — they are what the status bar shows and what the user has learned — so only the
 * line of grey text and the tooltip change (2026-10-05).
 */
const ESP_WORDING: Record<string, Pick<ControlDescriptor, 'detail' | 'tooltip'>> = {
    'rustyPlatform.flash': {
        detail: 'write the board',
        tooltip: 'Build and write over USB serial with espflash — an Xtensa chip has no probe route. '
            + 'Writes the release build by default; see rustyPlatform.flashProfile.',
    },
    // rustyPlatform.debug has no control row any more (Build for Debug / Build for Release replaced it),
    // so its ESP wording went with it. The command is still in the palette and still does flash + monitor.
    'rustyPlatform.monitor': {
        detail: 'the serial log',
        tooltip: 'espflash monitor — the log over the same serial port the flash used, without writing '
            + 'anything. Holds the port until its terminal is closed.',
    },
};

/**
 * The wording overrides for a family, applied to whichever controls name a route. `unknown` (and any
 * family that is not ESP) keeps the Raspberry Pi wording, the one every line was written for.
 */
function withEspWording(controls: ControlDescriptor[], family: HealthFamily): ControlDescriptor[] {
    if (family !== 'esp') {
        return controls;
    }
    return controls.map((control) => {
        const wording = ESP_WORDING[control.command];
        return wording === undefined ? control : { ...control, ...wording };
    });
}

/**
 * The controls that apply now, worded for the board in front of the user.
 *
 * The family defaults to `unknown`, which keeps the Raspberry Pi wording: it is the one every line was
 * written for, and a project we cannot identify should not be described as if we had identified it.
 */
export function visibleControls(
    sessionRunning: boolean,
    family: HealthFamily = 'unknown',
): ControlDescriptor[] {
    // The side panel shows everything the status bar shows, plus the profile overrides and the
    // packaging controls.
    // The two that lead the section are the ones that make the others possible -- the designer draws the
    // project, and New Project makes one -- and neither is in CONTROLS, which is also the status-bar list.
    const controls = [
        OPEN_DESIGNER_CONTROL,
        NEW_PROJECT_CONTROL,
        ...CONTROLS,
        ...FLASH_PROFILE_CONTROLS,
        ...PACKAGE_CONTROLS,
    ].filter((control) => control.sessionOnly !== true || sessionRunning);
    return withEspWording(controls, family);
}

/**
 * The status bar's *action* controls for the current window -- everything in `CONTROLS` except the health
 * row, which the status bar keeps whether or not a project is open.
 *
 * The actions are about doing something *to a project*, so while the window holds no Rusty Platform project
 * they are hidden rather than left showing dead: pressing Build with nothing to build only reaches the
 * "No Rusty Platform project found" warning. Hiding them also stops the strip from advertising Flash and
 * Monitor in a window that has no board in it at all.
 *
 * `projectOpen` is `RustyState.hasProject` -- a workspace folder with a `Cargo.toml`, the same rule the
 * Project view's "No Rusty Platform project in this workspace" uses.
 */
export function statusBarActions(
    projectOpen: boolean,
    sessionRunning: boolean,
    family: HealthFamily = 'unknown',
): ControlDescriptor[] {
    if (!projectOpen) {
        return [];
    }
    const actions = ACTION_CONTROLS.filter((control) => control.sessionOnly !== true || sessionRunning);
    return withEspWording(actions, family);
}

/**
 * What the health row needs: the two toolchain statuses, plus which silicon the open project is for.
 *
 * The family is part of it because the *verdict* depends on it — "no probe" is a fault on a Pico and a
 * fact of life on an ESP32, and the ESP toolchain is the reverse (see `toolchain/health.ts`).
 */
export interface HealthSummaryInput {
    status?: ToolchainStatus;
    esp?: EspToolchainStatus;
    family: HealthFamily;
    cargoOnShellPath: boolean;
}

/** Caption, one-line detail and tooltip of the health control, for a given toolchain status. */
export function healthSummary(input: HealthSummaryInput): HealthSummary {
    const status = input.status;
    if (status === undefined) {
        return {
            icon: 'chip',
            label: 'Rusty: detecting…',
            detail: 'detecting…',
            markdown: 'Detecting the Rust toolchain…',
        };
    }

    const report = healthReport(input);
    const espLine = input.esp === undefined ? [] : [`**esp** ${espToolchainSummary(input.esp)}`];
    const espSummary = input.esp === undefined ? 'not detected' : espToolchainSummary(input.esp);
    // Which line is worth a row depends on the family: an Xtensa project has no probe to report, and a
    // Raspberry Pi one has no Xtensa toolchain to install.
    const versions = input.family === 'esp'
        ? `cargo ${status.cargo.version ?? '?'} · esp ${espSummary}`
        : `cargo ${status.cargo.version ?? '?'} · probe-rs ${status.probeRs.version ?? '?'}`;

    if (report.ok) {
        const probe = status.probes[0]?.name ?? 'none';
        return {
            icon: 'chip',
            label: 'Rusty: ready',
            detail: versions,
            markdown: [
                `**cargo** ${status.cargo.version ?? '?'}`,
                ...(input.family === 'esp'
                    ? [...espLine, `**targets** ${status.installedTargets.filter((t) => t !== 'x86_64-unknown-linux-gnu').join(', ')}`]
                    : [
                        `**probe-rs** ${status.probeRs.version ?? '?'}`,
                        `**targets** ${status.installedTargets.filter((t) => t !== 'x86_64-unknown-linux-gnu').join(', ')}`,
                        ...espLine,
                        `**probe** ${probe} — ${status.probeDiagnosis.message}`,
                    ]),
            ].join('  \n'),
        };
    }

    return {
        icon: 'warning',
        label: 'Rusty: setup needed',
        detail: report.problems[0] ?? 'setup needed',
        // Only the problems: the ESP line is a *note* for a Raspberry Pi workspace, and the check
        // command prints it in the output. Putting it in the warning is how an RP-only user ended up
        // being told about espup they do not need.
        markdown: report.problems.join('  \n'),
    };
}
