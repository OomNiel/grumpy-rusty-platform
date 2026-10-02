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

    // The chip feature is the most reliable signal: rp2040 vs rp235xa/rp235xb.
    for (const board of BOARDS) {
        const chipFeature = board.embassyFeatures.find((f) => f === 'rp2040' || f.startsWith('rp235x'));
        if (chipFeature && new RegExp(`["']${chipFeature}["']`).test(cargoToml)) {
            return board;
        }
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
