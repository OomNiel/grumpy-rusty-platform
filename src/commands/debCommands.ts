/* The two Controls that build a `.deb` and install it (asked 2026-10-05).
 *
 * *"In the Controls section … add a control to publish the project to a .deb file, and another to install the
 * .deb on the host machine. The deb file must land in the project root."*
 *
 * The package's contents and every string in it come from `deb/package.ts` (pure, tested); what is here is the
 * three processes it takes — `cargo build --release`, `dpkg-deb --build`, `sudo dpkg -i` — and the questions
 * around them. Nothing is ever built or installed silently: the publish reports the path it wrote, and the
 * install shows `dpkg-deb --info` before asking, because installing into `/usr` is the one action here that
 * changes the machine rather than the project.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log, logError } from '../ai/log';
import { readActiveProject } from '../project/activeProject';
import { augmentedEnv } from '../util/exec';
import {
    controlFileText,
    debFileName,
    debUnsupportedReason,
    debianPackageName,
    flashWrapperScript
} from '../deb/package';

/** `amd64`, `arm64`, `armhf` — the host's architecture, which is what dpkg installs onto. */
export function debianArchitecture(arch: string = process.arch): string {
    if (arch === 'x64') return 'amd64';
    if (arch === 'arm64') return 'arm64';
    if (arch === 'arm') return 'armhf';
    if (arch === 'ia32') return 'i386';
    return arch || 'all';
}

/** The project folder of the window the control was pressed in, or a sentence saying why there is none. */
function projectRoot(): string | undefined {
    const project = readActiveProject() as { root?: string } | undefined;
    const root = project?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root && fs.existsSync(path.join(root, 'Cargo.toml')) ? root : undefined;
}

/** The crate's name, version and the board line, straight out of `Cargo.toml`. */
function crateInfo(root: string): { name: string; version: string; board?: string } {
    let text = '';
    try {
        text = fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8');
    } catch {
        return { name: path.basename(root), version: '0.0.0' };
    }
    const section = /^\[package\]([\s\S]*?)(?=^\[|\Z)/m.exec(text)?.[1] ?? text;
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? path.basename(root);
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? '0.0.0';
    const board = /^\s*board\s*=\s*"([^"]+)"/m.exec(text)?.[1];
    return { name, version, board };
}

/** The firmware the build produced, newest first: `target/<triple>/release/<name>` or `target/release/<name>`. */
export function firmwareArtifacts(root: string, crateName: string): string[] {
    const target = path.join(root, 'target');
    const candidates: string[] = [];
    const push = (dir: string): void => {
        for (const ext of ['', '.bin', '.uf2', '.elf']) {
            const file = path.join(dir, `${crateName}${ext}`);
            try {
                if (fs.statSync(file).isFile()) candidates.push(file);
            } catch { /* not produced by this project */ }
        }
    };
    push(path.join(target, 'release'));
    try {
        for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name !== 'release') push(path.join(target, entry.name, 'release'));
        }
    } catch { /* no target folder yet: the build has never run */ }
    const mtime = (file: string): number => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
    return candidates.sort((a, b) => mtime(b) - mtime(a));
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
        cp.execFile(cmd, args, { cwd, env: augmentedEnv(), maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            const code = err && typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : err ? 1 : 0;
            resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` });
        });
    });
}

/**
 * "Rusty: Publish .deb" — build the firmware, pack it with a flash helper, and write the `.deb` into the
 * **project root**, which is where the control's own documentation says it goes.
 */
export async function publishDeb(): Promise<void> {
    const unsupported = debUnsupportedReason();
    if (unsupported) {
        void vscode.window.showWarningMessage(unsupported);
        return;
    }
    const root = projectRoot();
    if (!root) {
        void vscode.window.showWarningMessage('No Rust project is open in this window, so there is nothing to package.');
        return;
    }
    const { name, version, board } = crateInfo(root);
    const pkg = debianPackageName(name);
    const arch = debianArchitecture();

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Publishing ${pkg} as a .deb`, cancellable: true },
        async (progress) => {
            progress.report({ message: 'building the firmware (cargo build --release)…' });
            const built = await run('cargo', ['build', '--release'], root);
            if (built.code !== 0) {
                logError(`deb: cargo build failed\n${built.out.slice(-2000)}`);
                void vscode.window.showErrorMessage(
                    'The release build failed, so there is nothing to package. See View → Output → "Grumpy\'s Rusty Platform".'
                );
                return;
            }
            const artifacts = firmwareArtifacts(root, name);
            if (!artifacts.length) {
                void vscode.window.showErrorMessage(
                    `The build succeeded but no artifact for "${name}" was found under target/ — is the crate's [[bin]] named "${name}"?`
                );
                return;
            }
            const payload = artifacts[0]!;
            const artifactName = path.basename(payload);

            // A staging tree is what dpkg-deb packs; `--root-owner-group` keeps it from needing fakeroot.
            const stage = fs.mkdtempSync(path.join(os.tmpdir(), `rusty-deb-${pkg}-`));
            const controlDir = path.join(stage, 'DEBIAN');
            const shareDir = path.join(stage, 'usr', 'share', pkg);
            const binDir = path.join(stage, 'usr', 'bin');
            fs.mkdirSync(controlDir, { recursive: true });
            // `mkdtemp` makes the staging folder 0700, and that mode ends up as the archive's own `./` entry —
            // a real `.deb` has 0755 there (seen with `dpkg-deb --contents` on the first real build, 2026-10-05).
            fs.chmodSync(stage, 0o755);
            fs.mkdirSync(shareDir, { recursive: true });
            fs.mkdirSync(binDir, { recursive: true });

            let payloadBytes = 0;
            for (const file of artifacts) {
                fs.copyFileSync(file, path.join(shareDir, path.basename(file)));
                payloadBytes += fs.statSync(file).size;
            }
            const wrapper = path.join(binDir, `${pkg}-flash`);
            fs.writeFileSync(wrapper, flashWrapperScript(name, artifactName));
            fs.chmodSync(wrapper, 0o755);

            // The control file's Installed-Size wants the whole tree, and it is written after the payload so the
            // number can be real rather than guessed.
            const treeBytes = payloadBytes + Buffer.byteLength(flashWrapperScript(name, artifactName)) + 512;
            fs.writeFileSync(path.join(controlDir, 'control'), controlFileText({
                crateName: name,
                version,
                architecture: arch,
                maintainer: maintainer(),
                description: `Firmware for ${board ?? name} (${artifactName})`,
                board,
                packageSizeBytes: treeBytes
            }));

            progress.report({ message: 'packing it with dpkg-deb…' });
            const out = path.join(root, debFileName(name, version, arch));
            fs.rmSync(out, { force: true });
            const packed = await run('dpkg-deb', ['--build', '--root-owner-group', stage, out], root);
            fs.rmSync(stage, { recursive: true, force: true });
            if (packed.code !== 0) {
                logError(`deb: dpkg-deb failed\n${packed.out.slice(-2000)}`);
                void vscode.window.showErrorMessage(`dpkg-deb could not build the package: ${packed.out.trim().split('\n').slice(-2).join(' ')}`);
                return;
            }
            const size = fs.statSync(out).size;
            log(`deb: wrote ${out} (${size} bytes) with ${artifacts.length} artifact(s)`);
            const pick = await vscode.window.showInformationMessage(
                `${path.basename(out)} is in the project root — it carries ${artifacts.map((f) => path.basename(f)).join(', ')} `
                + `and installs ${pkg}-flash. Install it now?`,
                'Install it',
                'Show me the file',
                'Later'
            );
            if (pick === 'Show me the file') {
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(out));
            } else if (pick === 'Install it') {
                await installDeb();
            }
        }
    );
}

/** The maintainer line dpkg insists on: the user's own git identity when there is one, a local default when not. */
function maintainer(): string {
    const email = String(process.env.GIT_AUTHOR_EMAIL ?? '').trim();
    const who = String(process.env.GIT_AUTHOR_NAME ?? process.env.USER ?? os.userInfo().username ?? '').trim();
    if (email) return `${who || 'unknown'} <${email}>`;
    try {
        const name = cp.execFileSync('git', ['config', '--get', 'user.name'], { encoding: 'utf8', timeout: 2000 }).trim();
        const mail = cp.execFileSync('git', ['config', '--get', 'user.email'], { encoding: 'utf8', timeout: 2000 }).trim();
        if (mail) return `${name || 'unknown'} <${mail}>`;
    } catch { /* no git, or no identity configured: the default below is still a valid control file */ }
    return `${who || os.userInfo().username} <${who || 'unknown'}@localhost>`;
}

/**
 * "Rusty: Install .deb" — install the package this project published, after showing what is in it.
 *
 * `sudo dpkg -i` runs in a **VS Code terminal** rather than behind `execFile`, for one reason: it needs the
 * user's password, and a spawned process with no terminal has nowhere to type it. The terminal also leaves the
 * command in the scrollback, so the same install can be repeated without the extension.
 */
export async function installDeb(): Promise<void> {
    const unsupported = debUnsupportedReason();
    if (unsupported) {
        void vscode.window.showWarningMessage(unsupported);
        return;
    }
    const root = projectRoot();
    if (!root) {
        void vscode.window.showWarningMessage('No Rust project is open in this window, so there is no .deb to install.');
        return;
    }
    let debs: string[] = [];
    try {
        debs = fs.readdirSync(root).filter((f) => f.endsWith('.deb')).map((f) => path.join(root, f));
    } catch { /* handled by the empty list below */ }
    if (!debs.length) {
        void vscode.window.showWarningMessage('No .deb in the project root yet — run "Rusty: Publish .deb" first.');
        return;
    }
    const newest = debs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]!;

    const info = await run('dpkg-deb', ['--info', newest], root);
    const pick = await vscode.window.showWarningMessage(
        `Install ${path.basename(newest)} on this machine?`,
        {
            modal: true,
            detail: `${info.out.trim().split('\n').slice(0, 8).join('\n')}\n\n`
                + 'It will install firmware into /usr/share and a <package>-flash command into /usr/bin. '
                + 'sudo will ask for your password in the terminal.'
        },
        'Install it'
    );
    if (pick !== 'Install it') return;
    const terminal = vscode.window.createTerminal({ name: 'Rusty: install .deb', cwd: root });
    terminal.show();
    terminal.sendText(`sudo dpkg -i ${shellQuote(newest)}`, true);
    log(`deb: install started in a terminal for ${newest}`);
}

/** One argument, quoted for the shell — a project path with a space in it is not a syntax error. */
export function shellQuote(value: string): string {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
