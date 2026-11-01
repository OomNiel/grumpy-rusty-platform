import * as vscode from 'vscode';
import { BOARDS } from '../boards/catalog';
import { BoardProfile } from '../boards/types';
import {
    AppTemplate,
    crateNameFrom,
    isAcceptableProjectName,
    requiredFirmware,
} from '../generate/files';
import { SketchBackend, availableBackends, projectFiles, requiredTemplateFiles } from '../generate/backends';
import { showDesigner } from '../designer/editor';
import { copyVendoredCrates } from '../designer/vendored';
import { forgetPendingDesigner, requestDesignerAfterReload } from '../designer/pendingOpen';
import {
    LCD_ROTATION_CHOICES,
    LCD_ROTATION_LABELS,
    LcdRotation,
    templateUsesPanel,
} from '../display/rotation';
import { needsPanelChoice, panelChoices, displayFor, touchFor } from '../boards/esp';
import { PANEL_MODULES, defaultWiring, type PanelWiring } from '../boards/panels';
import type { BoardChoices } from '../boards/esp';
import { installFirmwareIntoProject } from '../toolchain/cyw43FirmwareRunner';
import { samePath } from '../project/workspaceFolders';
import { writeArduinoIntelliSense } from '../toolchain/arduinoIntelliSense';
import { ensureEspToolchain } from './espToolchainCommands';
import { runInTerminal } from './terminal';

/**
 * Makes the folder that was just created the folder the window is working in.
 *
 * This is part of *creating* a project, not something a button does afterwards: a project the extension wrote
 * but the window does not know about has no Explorer entry, no Source Control and no terminal opened in it, so
 * the user has to go and open by hand the thing they just asked for. The Designer made that obvious, because its
 * button opened the canvas instead of the folder.
 *
 * It opens it as a **plain folder** -- `vscode.openFolder`, one root, no workspace file -- which is what a
 * generated project is and what every other template has always done. The first version of this fix used
 * `updateWorkspaceFolders` to avoid the reload that `openFolder` costs, and that was a mistake worth recording:
 * adding a folder to a window that has none does not produce a plain window with a folder in it, it produces an
 * *untitled workspace*, which VS Code then wants to save as a `.code-workspace` file. A generated project would
 * have arrived as a workspace, and stayed one, for no reason the user asked for.
 *
 * The reload is handled where it happens: a Designer asked for before it is recorded in global state and
 * reopened afterwards (see `src/designer/pendingOpen.ts`).
 *
 * Returns true when the folder was already the one this window has open, so the session carries on and the
 * caller can still do something with it.
 */
async function openProjectFolder(target: vscode.Uri): Promise<boolean> {
    const open = vscode.workspace.workspaceFolders ?? [];
    const only = open.length === 1 ? open[0] : undefined;
    if (only !== undefined && samePath(only.uri.fsPath, target.fsPath)) {
        // Already this window's folder: reloading to open what is open would be a no-op with a price.
        return true;
    }
    await vscode.commands.executeCommand('vscode.openFolder', target, { forceNewWindow: false });
    return false;
}

/**
 * Which language the project is written in -- the first question, because templates, generated files and the
 * toolchain all follow from the answer.
 *
 * It is **not asked while there is only one backend**: a question with one possible answer is a step nobody
 * can get wrong and nobody should pay for, and today's build has Rust alone. Phase 2 of
 * `plans/arduino-backend.md` registers the second backend, and this step appears by itself when it does.
 */
async function pickLanguage(): Promise<SketchBackend | undefined> {
    const backends = availableBackends();
    if (backends.length === 1) {
        return backends[0];
    }
    const picked = await vscode.window.showQuickPick(
        backends.map((backend) => ({
            label: backend.label,
            detail: backend.detail,
            backend,
        })),
        {
            title: "Grumpy's Rusty Platform — which language?",
            placeHolder: 'Language',
        },
    );
    return picked?.backend;
}

async function pickBoard(preferredId: string | undefined): Promise<BoardProfile | undefined> {
    const defaultId = preferredId ?? vscode.workspace.getConfiguration('rustyPlatform').get<string>('defaultBoard');
    const ordered = [...BOARDS].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));

    const picked = await vscode.window.showQuickPick(
        ordered.map((board) => ({
            label: board.name,
            description: `${board.family} · ${board.target}`,
            detail: board.notes,
            board,
        })),
        { title: "Grumpy's Rusty Platform — select a board", placeHolder: 'Board', ignoreFocusOut: false },
    );
    return picked?.board;
}

/**
 * Wireless boards can generate more than one kind of application, so ask which one.
 * Wired boards have a single option and are not asked about at all.
 */
async function pickTemplate(backend: SketchBackend, board: BoardProfile): Promise<AppTemplate | undefined> {
    // What the board's option *offers*, which is narrower for the ESP32-035: its menu is the WYSIWYG
    // designer alone, and a board with one option is not asked about at all. Which templates those are is the
    // backend's answer, not this function's: a C++ Pico has no Embassy menu to offer.
    const options = backend.templatesOfferedFor(board);
    if (options.length === 1) {
        return options[0]?.id ?? backend.defaultTemplateFor(board);
    }
    const picked = await vscode.window.showQuickPick(
        options.map((info) => ({
            label: info.label,
            detail: info.description,
            template: info.id,
        })),
        {
            title: `${board.name} — what should it do?`,
            placeHolder: 'Application template',
        },
    );
    return picked?.template;
}

/**
 * How far to turn the panel.
 *
 * Only asked when the template actually drives one, and asked with the four values spelled out rather than
 * as 0-3: the number is what the firmware reads, but nobody thinks in it. The answer is written into the
 * project's config and settings, never into `src/main.rs`.
 */
async function pickRotation(board: BoardProfile, template: AppTemplate): Promise<LcdRotation | undefined> {
    if (!templateUsesPanel(template)) {
        return 0;
    }
    const picked = await vscode.window.showQuickPick(
        LCD_ROTATION_CHOICES.map((rotation) => ({
            label: LCD_ROTATION_LABELS[rotation],
            description: rotation === 0 ? 'recommended' : `${rotation}`,
            rotation,
        })),
        {
            title: `${board.name} — how is the panel mounted?`,
            placeHolder: 'LCD rotation',
        },
    );
    return picked?.rotation;
}

/**
 * Whether the project should drive its touch controller.
 *
 * Asked where the rotation is asked -- at creation, beside it -- because both are project settings the firmware
 * reads at compile time, and both are changeable later from the designer's toolbar. Only a Designer project on
 * a board that *has* a controller is asked: the named templates are what their names say, and a board without a
 * controller has nothing to switch.
 */
async function pickTouch(
    board: BoardProfile,
    template: AppTemplate,
    choices: BoardChoices,
): Promise<boolean | undefined> {
    // The controller can belong to the display module (a DevKitC's ILI9341) rather than to the board, so the
    // question is asked of the panel this project is being made for -- and only after that panel is known.
    const controller = board.kind === 'esp' ? touchFor(board, displayFor(board, choices)) : undefined;
    if (template !== 'designer' || controller === undefined) {
        return true;
    }
    const picked = await vscode.window.showQuickPick(
        [
            {
                label: 'Touchscreen',
                description: 'recommended',
                detail:
                    'The panel reacts to fingers: buttons, sliders and toggles in the design work, and the ' +
                    'firmware carries the touch driver and asks for the four corners once.',
                enabled: true,
            },
            {
                label: 'Display only',
                description: 'no touch driver, no calibration screen',
                detail:
                    'The design is drawn and nothing responds. Dropping a control later turns this back on, ' +
                    'and the setting can be changed any time from the designer.',
                enabled: false,
            },
        ],
        {
            title: `${board.name} — does this project use the touchscreen?`,
            placeHolder: 'Touch',
        },
    );
    return picked?.enabled;
}

async function pickPanel(board: BoardProfile, template: AppTemplate): Promise<BoardChoices | undefined> {
    if (!templateUsesPanel(template) || board.kind !== 'esp' || !needsPanelChoice(board)) {
        return {};
    }
    const choices = panelChoices(board);
    const picked = await vscode.window.showQuickPick(
        choices.map((choice) => ({
            label: choice.label,
            description: choice.description,
            choice,
        })),
        {
            title: `${board.name} — select a display`,
            placeHolder: 'Display module',
        },
    );
    if (!picked) {
        return undefined;
    }
    return { panel: picked.choice.id };
}

/**
 * Which display module is wired to this Pico, for a template that drives one.
 *
 * The ESP side asks the same question and records the answer as a cargo feature; a Pico has no soldered
 * panel at all, so the answer becomes the starting wiring in `designer/panel.hardware.json` -- every GPIO
 * of which is editable in the Designer afterwards. The three modules are the ones the ESP32-DevKitC
 * option lists, so a module bought for one board works on the other.
 */
async function pickPanelModule(
    board: BoardProfile,
    template: AppTemplate,
): Promise<string | null | undefined> {
    if (!templateUsesPanel(template) || board.kind !== 'rp') {
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(
        PANEL_MODULES.map((module) => ({
            label: module.label,
            description: module.touch ? 'with XPT2046 touch' : 'no touch controller',
            detail: module.description,
            module,
        })),
        {
            title: `${board.name} — which display module is wired?`,
            placeHolder: 'Display module',
        },
    );
    return picked?.module.id ?? null;
}

async function pickParentFolder(): Promise<vscode.Uri | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        const chosen = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Create project here',
            title: 'Select the parent folder for the new project',
        });
        return chosen?.[0];
    }

    const options = [
        ...folders.map((folder) => ({
            label: `$(folder) ${folder.name}`,
            description: folder.uri.fsPath,
            uri: folder.uri,
        })),
        { label: '$(folder-opened) Choose another folder…', description: 'Pick a location outside this window', uri: undefined },
    ];

    const picked = await vscode.window.showQuickPick(options, {
        title: 'Where should the project go?',
        placeHolder: 'Parent folder',
    });
    if (!picked) {
        return undefined;
    }
    if (picked.uri) {
        return picked.uri;
    }
    const chosen = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Create project here',
    });
    return chosen?.[0];
}

async function ensureWritableTarget(target: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(target);
    } catch {
        return true; // does not exist: good
    }
    const choice = await vscode.window.showWarningMessage(
        `The folder already exists: ${target.fsPath}`,
        { modal: true },
        'Overwrite generated files',
    );
    return choice === 'Overwrite generated files';
}

export function registerNewProjectCommand(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): vscode.Disposable {
    return vscode.commands.registerCommand('rustyPlatform.newProject', async (boardId?: string) => {
        const backend = await pickLanguage();
        if (backend === undefined) {
            return;
        }

        const board = await pickBoard(boardId);
        if (!board) {
            return;
        }

        const template = await pickTemplate(backend, board);
        if (!template) {
            return;
        }

        const rotation = await pickRotation(board, template);
        if (rotation === undefined) {
            return;
        }

        // A Pico's panel is wired, not soldered: the module is the first half of the answer and the GPIOs
        // (every one of which is editable in the Designer) are the other.
        const panelModule = await pickPanelModule(board, template);
        if (panelModule === null) {
            return;
        }
        const wiring: PanelWiring | undefined =
            board.kind === 'rp' && templateUsesPanel(template)
                ? defaultWiring(board, panelModule === undefined ? undefined : panelModule)
                : undefined;

        // The panel first: which display module is attached decides whether there is a touch controller at
        // all, so the touch question cannot come before it.
        const panelChoicesAnswer = await pickPanel(board, template);
        if (panelChoicesAnswer === undefined) {
            return;
        }

        const touch = await pickTouch(board, template, panelChoicesAnswer);
        if (touch === undefined) {
            return;
        }

        // Named after the template, not always "blinky": the default used to be `blinky-<board>` whatever was
        // chosen, so a WYSIWYG project arrived as `blinky_pico2w` — a folder, a sketch and a README that all say
        // blinky, from a menu item called WYSIWYG designer (bench, 2026-11-01). The first thing a person checks
        // is the name, so the name has to be true.
        const templateLabel = backend.templatesOfferedFor(board).find((info) => info.id === template)?.label ?? template;
        const projectName = await vscode.window.showInputBox({
            title: `${board.name} — project name`,
            prompt: `Folder and project name (${templateLabel})`,
            value: `${template}-${board.id}`,
            validateInput: (value) => {
                const verdict = isAcceptableProjectName(value);
                return verdict === true ? undefined : verdict;
            },
        });
        if (!projectName) {
            return;
        }

        const parent = await pickParentFolder();
        if (!parent) {
            return;
        }

        const folderName = backend.folderName(projectName);
        const target = vscode.Uri.joinPath(parent, folderName);
        if (!(await ensureWritableTarget(target))) {
            return;
        }

        const files = projectFiles(backend, {
            board,
            projectName,
            template,
            rotation,
            touch,
            choices: panelChoicesAnswer,
            wiring,
            // The Wi-Fi clock shows local time; the machine that creates the project is the only
            // thing here that knows the offset. getTimezoneOffset counts minutes west of UTC.
            clockOffsetMinutes: -new Date().getTimezoneOffset(),
        });
        // What was asked for has to be what is written. A WYSIWYG project without its design or its
        // code-behind is a blinky with a different label, and a wizard that reports success is how that stays
        // unnoticed until the canvas opens empty.
        const signatures = requiredTemplateFiles(backend, template).filter(
            (path) => !files.some((file) => file.path === path),
        );
        if (signatures.length > 0) {
            void vscode.window.showErrorMessage(
                `The ${templateLabel} project was not written: this generator does not produce ` +
                    `${signatures.join(', ')} for ${board.name}. Nothing was created.`,
            );
            return;
        }
        for (const file of files) {
            const segments = file.path.split('/');
            const directory = vscode.Uri.joinPath(target, ...segments.slice(0, -1));
            await vscode.workspace.fs.createDirectory(directory);
            await vscode.workspace.fs.writeFile(
                vscode.Uri.joinPath(target, ...segments),
                Buffer.from(file.content, 'utf8'),
            );
        }

        // A C++ project has to be described to the editor as well as written: Arduino's headers live in
        // whichever core is installed, so the include paths come from arduino-cli itself (see
        // toolchain/arduinoIntelliSense.ts). Best-effort: a project made without the core installed is still a
        // project, and "Arduino: Refresh C++ IntelliSense" is how it is finished off later.
        if (backend.id === 'arduino') {
            const outcome = await writeArduinoIntelliSense({ project: target, output });
            if (outcome !== 'written') {
                output.appendLine(`[new-project] IntelliSense config written without a database (${outcome})`);
            }
        }

        // An ESP project cannot be built or flashed without the Xtensa toolchain, and the
        // natural moment to set it up is here, when the project that needs it appears.
        // The C++ side's equivalent -- the arduino-esp32 core -- is offered by the toolchain phase.
        if (board.kind === 'esp' && backend.id === 'rust') {
            await ensureEspToolchain(output);
        }

        // Wireless boards need the CYW43 blobs next to the generated firmware/README.md.
        // Only RP boards have a CYW43, so an ESP project has nothing to copy here -- and a C++ project needs
        // none of them either: arduino-pico ships the blobs inside its own core.
        const blobNames =
            board.kind === 'rp' && backend.id === 'rust'
                ? requiredFirmware(board, template).map((blob) => blob.fileName)
                : [];
        if (blobNames.length > 0) {
            try {
                await installFirmwareIntoProject(target, blobNames, { output });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                output.appendLine(`CYW43 firmware failed: ${message}`);
                output.show(true);
                const choice = await vscode.window.showErrorMessage(
                    `Project created, but the wireless firmware could not be fetched: ${message.split('\n')[0]}`,
                    'Show Log',
                );
                if (choice === 'Show Log') {
                    output.show(true);
                }
            }
        }

        // A Designer project pulls its shapes from `rusty-gui-widgets` and its KDL from the codegen fork that
        // emits `add_custom_widget` calls for shapes; the `Cargo.toml` references them under `codegen/`, so the
        // wizard copies both crates from the extension's `crates/` folder into the project. This mirrors the
        // CYW43-blob copy just above: a runtime side effect, not a generated file, so the golden snapshots stay
        // a faithful record of what the generator itself emits.
        if (template === 'designer' && backend.id === 'rust') {
            try {
                copyVendoredCrates(context, target, output);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                output.appendLine(`Vendored crates failed: ${message}`);
                output.show(true);
                void vscode.window.showErrorMessage(
                    `Project created, but its shapes crate could not be copied: ${message.split('\n')[0]}`,
                );
            }
        }

        const crateName = crateNameFrom(projectName);
        // A Designer project's whole point is the canvas, so the prompt offers it first and passes the folder
        // that was just written, which may not be a workspace folder at all.
        //
        // Both languages, because both have a Designer now: a C++ WYSIWYG project opens the same canvas, and its
        // save path writes `src/ui.cpp` through the LVGL emitter. It was `backend.id === 'rust'` here long after
        // the C++ canvas worked, so the wizard created a designer project and then offered "Open Project" — the
        // option looked missing because nothing ever opened it (bench, 2026-10-31). "Build Now" stays Rust-only:
        // it runs `cargo build`, and a sketch's build goes through arduino-cli with a captured log.
        const canDesign = template === 'designer';
        const opening = canDesign ? 'Open Designer' : 'Open Project';
        const buttons = backend.id === 'rust' ? [opening, 'Build Now', 'Later'] : [opening, 'Later'];
        const action = await vscode.window.showInformationMessage(
            `Created ${backend.id === 'rust' ? crateName : folderName
            } for ${board.name} — ${templateLabel}, ${files.length} files.`,
            ...buttons,
        );

        const wantsDesigner = action === 'Open Designer';
        if (wantsDesigner) {
            // Recorded *before* the folder is loaded: loading it can restart this extension host, and a webview
            // panel cannot survive that. The next activation finds the request and opens it there.
            await requestDesignerAfterReload(context, target.fsPath);
        }

        // Loaded whatever the answer was, including "Later" and "Build Now": a project the window does not know
        // about has no Explorer entry, no Source Control and no terminal in it, so creating one and then not
        // showing it is only half the command. This is what the Designer flow used to skip.
        const loadedHere = await openProjectFolder(target);

        if (wantsDesigner && loadedHere) {
            // This session survived the folder change, so open it here -- and cancel the request, which was only
            // insurance for the restart that did not happen.
            await showDesigner(context, output, target);
            await forgetPendingDesigner(context);
        } else if (action === 'Open Project') {
            // The folder is already open, or is being opened, by `openProjectFolder` above -- so this is where
            // to look first, rather than a second request to open the same thing.
            await vscode.commands.executeCommand('revealInExplorer', target);
        } else if (action === 'Build Now') {
            runInTerminal(`Rusty: ${board.id}`, 'cargo build', target);
        }
    });
}

