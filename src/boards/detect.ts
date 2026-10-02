import { BoardProfile } from './types';
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

    // The chip feature (rp2040 vs rp235xa/rp235xb) narrows it to two boards; the
    // presence of the cyw43 dependency is what separates a W board from its wired
    // twin. Without this, pico2w projects were reported as pico2.
    const wireless = /^\s*cyw43\s*=/m.test(cargoToml);
    const chipMatches = BOARDS.filter((board) => {
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

/** Chip id for a project's `.cargo/config.toml` runner line, if we can read it. */
export function detectChipFromProject(files: ProjectFiles): string | undefined {
    const board = detectBoardFromProject(files);
    if (board) {
        return board.probeChip;
    }
    const match = /probe-rs\s+run\s+--chip\s+["']?([^\s"']+)["']?/.exec(files.cargoConfigToml ?? '');
    return match?.[1];
}
