import { BoardProfile, isEspBoard, isRpBoard } from './types';
import { BOARDS } from './catalog';

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

    // --- Espressif -----------------------------------------------------------
    // An esp-hal project names its silicon in a feature ("esp32" / "esp32s3"), so the
    // chip decides the family. Two boards share `esp32`, and the panel dependency is
    // what separates them: only the CYD drives a display.
    if (/^\s*esp-hal\s*=/m.test(cargoToml)) {
        const drivesDisplay = /^\s*mipidsi\s*=/m.test(cargoToml);
        const candidates = BOARDS.filter(isEspBoard).filter((board) =>
            new RegExp(`["']${board.espChip}["']`).test(cargoToml),
        );
        const matchingPanel = candidates.find(
            (board) => board.displays.length > 0 === drivesDisplay,
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
