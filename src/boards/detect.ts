import { BoardProfile, isEspBoard, isRpBoard } from './types';
import { BOARDS } from './catalog';
import { panelChoiceFromCargo } from './esp';

/**
 * Works out which board an existing project targets, from the files it contains.
 * Pure: takes file contents, returns a board (or `undefined`).
 */

export interface ProjectFiles {
    cargoToml: string;
    /** Contents of `.cargo/config.toml`, when present. */
    cargoConfigToml?: string;
}

export function detectBoardFromProject(files: ProjectFiles): BoardProfile | undefined {
    const { cargoToml, cargoConfigToml } = files;

    // --- the manifest's own header -------------------------------------------
    // A generated manifest opens with `# Board: <name> (<family>, <flash>)`, and that line is the most
    // precise answer a project gives. It has to be read before any guess: two ESP32 boards can both
    // drive a panel -- the DevKitC through a plug-in module, the ESP32-035 through its soldered one --
    // so "has mipidsi" no longer separates them, and the feature guess below took whichever board the
    // catalogue lists first. That read an ESP32-035 project as a DevKitC, whose default module has no
    // touch controller, which is why the Designer offered no Touch switch for a panel that has a
    // soldered XPT2046 (reported 2026-11-14).
    const header = /^#\s*Board:\s*(.+?)\s*$/m.exec(cargoToml)?.[1];
    if (header !== undefined) {
        const named = BOARDS.find(
            (candidate) => header === candidate.name || header.startsWith(`${candidate.name} (`),
        );
        if (named !== undefined) {
            return named;
        }
    }

    // --- Espressif -----------------------------------------------------------
    // An esp-hal project names its silicon in a feature ("esp32" / "esp32s3"), so the
    // chip decides the family. A board that takes a plug-in module records which one as a
    // `panel-<id>` feature, which names the board as well as the glass.
    if (/^\s*esp-hal\s*=/m.test(cargoToml)) {
        const drivesDisplay = /^\s*mipidsi\s*=/m.test(cargoToml);
        const candidates = BOARDS.filter(isEspBoard).filter((board) =>
            new RegExp(`["']${board.espChip}["']`).test(cargoToml),
        );
        const chosen = panelChoiceFromCargo(cargoToml);
        const byPanel = chosen === undefined
            ? undefined
            : candidates.find((board) => board.displays.some((display) => display.panelChoice === chosen));
        if (byPanel !== undefined) {
            return byPanel;
        }
        const matchingPanel = candidates.find(
            (board) => (board.displays.length > 0) === drivesDisplay,
        );
        return matchingPanel ?? candidates[0];
    }

    // --- Raspberry Pi --------------------------------------------------------
    // The chip feature (rp2040 vs rp235xa/rp235xb) narrows it to two boards; the
    // presence of the cyw43 dependency is what separates a W board from its wired
    // twin. Without this, pico2w projects were reported as pico2.
    const wireless = /^\s*cyw43\s*=/m.test(cargoToml);
    const chipMatches = BOARDS.filter(isRpBoard).filter((board) => {
        const chipFeature = board.embassyFeatures.find((f) => f === 'rp2040' || f.startsWith('rp235x'));
        return chipFeature ? new RegExp(`["']${chipFeature}["']`).test(cargoToml) : false;
    });

    const chipAndRadio = chipMatches.find((board) => (board.wireless !== 'none') === wireless);
    if (chipAndRadio) {
        return chipAndRadio;
    }
    if (chipMatches.length > 0) {
        return chipMatches[0];
    }

    // Fall back to the target triple in .cargo/config.toml.
    if (cargoConfigToml) {
        const triple = /^\s*target\s*=\s*["']([^"']+)["']/m.exec(cargoConfigToml)?.[1];
        return BOARDS.find((b) => b.target === triple);
    }

    return undefined;
}

/**
 * Chip id for a project's tooling, if we can work it out.
 *
 * The board's own record is preferred over the runner line: a generated ESP project
 * names its chip in Cargo.toml, while the probe id lives in `.cargo/config.toml` only
 * for RP projects.
 */
export function detectChipFromProject(files: ProjectFiles): string | undefined {
    const board = detectBoardFromProject(files);
    if (board) {
        return board.kind === 'rp' ? board.probeChip : board.espChip;
    }
    const match = /probe-rs\s+run\s+--chip\s+["']?([^\s"']+)["']?/.exec(files.cargoConfigToml ?? '');
    return match?.[1];
}
