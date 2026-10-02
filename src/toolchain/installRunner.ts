import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
    InstallStep,
    PROBE_RS_VERSION,
    rustupInitUrl,
    UDEV_RULES_CONTENT,
    UDEV_RULES_PATH,
} from './installPlan';
import { augmentedEnv, cargoBinDir, findExecutable } from '../util/exec';

/**
 * Executes an installation plan. All side effects live here; the decisions live
 * in installPlan.ts so they can be unit-tested.
 */

export interface RunnerHost {
    output: vscode.OutputChannel;
}

function toolsRoot(): string {
    return path.join(os.homedir(), '.grumpy-rusty-platform', 'tools');
}

export function downloadFile(url: string, destination: string, redirects = 0): Promise<void> {
    return new Promise((resolve, reject) => {
        if (redirects > 5) {
            reject(new Error(`Too many redirects while downloading ${url}`));
            return;
        }
        https
            .get(url, { headers: { 'User-Agent': 'grumpy-rusty-platform' } }, (response) => {
                const status = response.statusCode ?? 0;
                if (status >= 300 && status < 400 && response.headers.location) {
                    response.resume();
                    downloadFile(new URL(response.headers.location, url).toString(), destination, redirects + 1)
                        .then(resolve)
                        .catch(reject);
                    return;
                }
                if (status !== 200) {
                    response.resume();
                    reject(new Error(`HTTP ${status} downloading ${url}`));
                    return;
                }
                const file = fs.createWriteStream(destination);
                response.pipe(file);
                file.on('finish', () => file.close(() => resolve()));
                file.on('error', reject);
            })
            .on('error', reject);
    });
}

export function sha256OfFile(file: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The published `.sha256` files are `<hex>  <filename>` (cargo-dist format). */
export function parseSha256File(contents: string): string | undefined {
    const match = /^([0-9a-f]{64})\s/i.exec(contents.trim());
    return match?.[1]?.toLowerCase();
}

function run(command: string, args: readonly string[], cwd?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], { cwd, env: augmentedEnv(), windowsHide: true });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${path.basename(command)} exited with ${code}: ${stderr.trim()}`));
            }
        });
    });
}

async function installRustup(host: RunnerHost, arch: string): Promise<void> {
    const url = rustupInitUrl(process.platform, arch);
    if (!url) {
        throw new Error('No automatic rustup installer for this platform. Install Rust from https://rustup.rs.');
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rusty-rustup-'));
    const installer = path.join(dir, process.platform === 'win32' ? 'rustup-init.exe' : 'rustup-init');
    host.output.appendLine(`Downloading ${url}`);
    await downloadFile(url, installer);
    if (process.platform !== 'win32') {
        fs.chmodSync(installer, 0o755);
    }
    host.output.appendLine('Running rustup-init (non-interactive, --no-modify-path)');
    await run(installer, ['-y', '--default-toolchain', 'stable', '--profile', 'default', '--no-modify-path']);
}

async function addTargets(host: RunnerHost, targets: readonly string[]): Promise<void> {
    const rustup = findExecutable('rustup');
    if (!rustup) {
        throw new Error('rustup not found after installation.');
    }
    for (const target of targets) {
        host.output.appendLine(`rustup target add ${target}`);
        await run(rustup, ['target', 'add', target]);
    }
}

async function installProbeRs(host: RunnerHost, step: InstallStep): Promise<void> {
    const asset = step.asset;
    if (!asset) {
        // Fall back to a source build when no prebuilt archive exists.
        const cargo = findExecutable('cargo');
        if (!cargo) {
            throw new Error('cargo is required to build probe-rs from source.');
        }
        host.output.appendLine('cargo install probe-rs-tools --locked (this takes several minutes)');
        await run(cargo, ['install', 'probe-rs-tools', '--locked']);
        return;
    }

    const version = PROBE_RS_VERSION;
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rusty-probe-rs-'));
    const archive = path.join(stage, asset.fileName);

    host.output.appendLine(`Downloading ${asset.url}`);
    await downloadFile(asset.url, archive);

    host.output.appendLine('Verifying SHA-256 checksum');
    const checksumFile = `${archive}.sha256`;
    await downloadFile(`${asset.url}.sha256`, checksumFile);
    const expected = parseSha256File(fs.readFileSync(checksumFile, 'utf8'));
    if (!expected) {
        throw new Error('Could not parse the published checksum file; aborting for safety.');
    }
    const actual = sha256OfFile(archive);
    if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${asset.fileName}\n  expected ${expected}\n  actual   ${actual}`);
    }
    host.output.appendLine(`Checksum OK (${actual})`);

    const extractDir = path.join(stage, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    if (asset.kind === 'tar.xz') {
        await run('tar', ['-xJf', archive, '-C', extractDir]);
    } else {
        await run('powershell', [
            '-NoProfile',
            '-Command',
            `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${extractDir}' -Force`,
        ]);
    }

    const binDir = path.join(toolsRoot(), 'probe-rs', version, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    // The archives nest everything in one top-level directory.
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    const root = entries.find((e) => e.isDirectory()) ? path.join(extractDir, entries[0]!.name) : extractDir;

    for (const binary of asset.binaries) {
        const source = path.join(root, binary);
        if (!fs.existsSync(source)) {
            continue;
        }
        const destination = path.join(binDir, binary);
        fs.copyFileSync(source, destination);
        if (process.platform !== 'win32') {
            fs.chmodSync(destination, 0o755);
        }
        host.output.appendLine(`Installed ${destination}`);
    }

    // Make it discoverable for anything that only looks at ~/.cargo/bin.
    const cargoBin = cargoBinDir();
    fs.mkdirSync(cargoBin, { recursive: true });
    for (const binary of asset.binaries) {
        const source = path.join(binDir, binary);
        if (fs.existsSync(source)) {
            fs.copyFileSync(source, path.join(cargoBin, binary));
        }
    }
    host.output.appendLine(`Linked probe-rs into ${cargoBin}`);
    host.output.appendLine(`(probe-rs also lives in ${binDir} — set rustyPlatform.probeRsPath to use it directly)`);
}

/**
 * The udev step cannot be automated: it needs root. We stage the rule file in a
 * temp location and hand the user a single sudo command in a real terminal so
 * they type the password themselves.
 */
async function installUdevRules(host: RunnerHost): Promise<void> {
    if (process.platform !== 'linux') {
        return;
    }
    const staged = path.join(os.tmpdir(), 'grumpy-rusty-platform-probe-rs.rules');
    fs.writeFileSync(staged, UDEV_RULES_CONTENT, 'utf8');

    const terminal = vscode.window.createTerminal({
        name: 'Rusty Platform: USB permissions',
        cwd: os.homedir(),
    });
    terminal.show();
    terminal.sendText(
        `sudo install -m0644 '${staged}' '${UDEV_RULES_PATH}' && ` +
        `sudo udevadm control --reload-rules && sudo udevadm trigger`,
    );
    host.output.appendLine(`Staged udev rules at ${staged}; waiting for sudo in the terminal.`);
    await vscode.window.showInformationMessage(
        'Type your password in the terminal to install the USB access rules. Reconnect the debug probe afterwards.',
    );
}

export async function runInstallPlan(
    host: RunnerHost,
    steps: readonly InstallStep[],
    arch: string,
): Promise<void> {
    if (steps.length === 0) {
        void vscode.window.showInformationMessage('Everything needed is already installed.');
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Grumpy's Rusty Platform setup", cancellable: false },
        async (progress) => {
            for (const [index, step] of steps.entries()) {
                progress.report({ message: `${index + 1}/${steps.length}: ${step.title}`, increment: 100 / steps.length });
                host.output.appendLine(`--- ${step.title} ---`);
                host.output.appendLine(step.detail);
                if (step.kind === 'udev') {
                    await installUdevRules(host);
                } else if (step.kind === 'rustup') {
                    await installRustup(host, arch);
                } else if (step.kind === 'target') {
                    await addTargets(host, step.target ? [step.target] : []);
                } else if (step.kind === 'probe-rs') {
                    await installProbeRs(host, step);
                }
            }
        },
    );

    void vscode.window.showInformationMessage("Grumpy's Rusty Platform setup finished.");
}
