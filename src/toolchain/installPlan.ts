import { ToolchainStatus } from './detect';

/**
 * Pure installation planning. No `vscode` import and no side effects, so the
 * t1-logic layer can assert exactly what we would do on a bare machine.
 *
 * Execution lives in installRunner.ts (VS Code terminals), keeping the risky
 * "what should happen" decisions testable.
 */

/** Pinned so the plan is reproducible; bump deliberately and update NOTES.md. */
export const PROBE_RS_VERSION = '0.32.0';

export const PROBE_RS_RELEASE_BASE = 'https://github.com/probe-rs/probe-rs/releases/download';

export interface ProbeRsAsset {
    url: string;
    fileName: string;
    kind: 'tar.xz' | 'zip';
    binaries: string[];
}

export type InstallStepKind = 'rustup' | 'target' | 'probe-rs' | 'udev';

export interface InstallStep {
    id: string;
    kind: InstallStepKind;
    title: string;
    detail: string;
    /** Only for `kind === 'target'`. */
    target?: string;
    /** Only for `kind === 'probe-rs'`. */
    asset?: ProbeRsAsset;
    /** True when the step must run with elevated privileges. */
    requiresElevation: boolean;
}

export interface InstallPlanOptions {
    /** Target triples that must be installed. */
    targets: string[];
    platform: NodeJS.Platform;
    arch: string;
    /** Override for tests. */
    probeRsVersion?: string;
}

const RUSTUP_TARGETS: Record<string, string> = {
    'linux:x64': 'x86_64-unknown-linux-gnu',
    'linux:arm64': 'aarch64-unknown-linux-gnu',
    'darwin:x64': 'x86_64-apple-darwin',
    'darwin:arm64': 'aarch64-apple-darwin',
    'win32:x64': 'x86_64-pc-windows-msvc',
};

export function rustupInitTarget(platform: NodeJS.Platform, arch: string): string | undefined {
    return RUSTUP_TARGETS[`${platform}:${arch}`];
}

export function rustupInitUrl(platform: NodeJS.Platform, arch: string): string | undefined {
    const target = rustupInitTarget(platform, arch);
    if (!target) {
        return undefined;
    }
    const suffix = platform === 'win32' ? 'rustup-init.exe' : 'rustup-init';
    return `https://static.rust-lang.org/rustup/dist/${target}/${suffix}`;
}

/** Prebuilt `probe-rs-tools` archive for the host, or `undefined` when unsupported. */
export function probeRsAssetFor(
    platform: NodeJS.Platform,
    arch: string,
    version: string = PROBE_RS_VERSION,
): ProbeRsAsset | undefined {
    const host =
        platform === 'linux'
            ? arch === 'x64'
                ? 'x86_64-unknown-linux-gnu'
                : arch === 'arm64'
                    ? 'aarch64-unknown-linux-gnu'
                    : undefined
            : platform === 'darwin'
                ? arch === 'x64'
                    ? 'x86_64-apple-darwin'
                    : arch === 'arm64'
                        ? 'aarch64-apple-darwin'
                        : undefined
                : platform === 'win32' && arch === 'x64'
                    ? 'x86_64-pc-windows-msvc'
                    : undefined;

    if (!host) {
        return undefined;
    }

    const zip = host.includes('windows');
    const ext = zip ? 'zip' : 'tar.xz';
    const base = zip ? 'probe-rs' : 'probe-rs';
    const binaries = zip
        ? [`${base}.exe`, 'cargo-embed.exe', 'cargo-flash.exe']
        : [base, 'cargo-embed', 'cargo-flash'];
    const fileName = `probe-rs-tools-${host}.${ext}`;

    return {
        url: `${PROBE_RS_RELEASE_BASE}/v${version}/${fileName}`,
        fileName,
        kind: zip ? 'zip' : 'tar.xz',
        binaries,
    };
}

/**
 * probe-rs udev rules. Covers Raspberry Pi (both the Debug Probe and a Pico
 * running `debugprobe_on_pico.uf2`) plus the usual CMSIS-DAP / ST-Link / J-Link
 * vendors. `uaccess` grants access to the logged-in desktop user, which is
 * friendlier than world-writable 0666.
 */
export const UDEV_RULES_PATH = '/etc/udev/rules.d/69-probe-rs.rules';

export const UDEV_RULES_CONTENT = `# probe-rs / Grumpy's Rusty Platform USB access rules
# Installed by Grumpy's Rusty Platform for VS Code.
SUBSYSTEM=="usb", ATTR{idVendor}=="2e8a", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="0d28", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="1366", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="0483", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="1a86", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="1209", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="03eb", MODE="0666", TAG+="uaccess"
`;

/**
 * Decides what is missing and in which order to install it.
 * Always returns steps cheapest-first: rustup -> targets -> probe-rs -> udev.
 */
export function planInstallation(
    status: ToolchainStatus,
    options: InstallPlanOptions,
): InstallStep[] {
    const steps: InstallStep[] = [];
    const needsRustup = !status.cargo.found || !status.rustup.found;

    if (needsRustup) {
        const url = rustupInitUrl(options.platform, options.arch);
        steps.push({
            id: 'rustup',
            kind: 'rustup',
            title: 'Install the Rust toolchain (rustup)',
            detail: url
                ? `Download and run the official rustup-init for this platform:\n${url}`
                : 'Unsupported platform/architecture for automatic rustup installation. Install Rust manually from https://rustup.rs.',
            requiresElevation: false,
        });
    }

    // Without rustup we cannot add targets; the rustup step itself will.
    const targetList = needsRustup ? options.targets : status.missingTargets;
    for (const target of [...new Set(targetList)].sort()) {
        steps.push({
            id: `target:${target}`,
            kind: 'target',
            title: `Add target ${target}`,
            detail: `rustup target add ${target}`,
            target,
            requiresElevation: false,
        });
    }

    if (!status.probeRs.found) {
        const asset = probeRsAssetFor(options.platform, options.arch, options.probeRsVersion);
        steps.push({
            id: 'probe-rs',
            kind: 'probe-rs',
            title: `Install probe-rs ${options.probeRsVersion ?? PROBE_RS_VERSION}`,
            detail: asset
                ? `Download the prebuilt release archive and verify its SHA-256 before installing:\n${asset.url}`
                : 'No prebuilt archive for this platform. Run: cargo install probe-rs-tools --locked',
            asset,
            requiresElevation: false,
        });
    }

    if (options.platform === 'linux' && !status.udevRulesPresent) {
        steps.push({
            id: 'udev',
            kind: 'udev',
            title: 'Install USB access rules (udev)',
            detail: `Write ${UDEV_RULES_PATH} and reload udev. Requires your password.`,
            requiresElevation: true,
        });
    }

    return steps;
}

/** Human-readable one-liner for a step, used in progress messages. */
export function describeStep(step: InstallStep): string {
    return `${step.title}${step.requiresElevation ? ' (needs sudo)' : ''}`;
}
