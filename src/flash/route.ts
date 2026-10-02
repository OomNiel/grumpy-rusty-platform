import { BoardProfile } from '../boards/types';
import { ProbeDiagnosisKind } from '../toolchain/detect';
import { SiliconFamily } from './bootsel';
import { UF2_FAMILIES, uf2FamilyForBoard } from './uf2';

/**
 * Which way a "flash" should go, and for which silicon.
 *
 * The decision is separated from the command so it can be tested: the interesting cases are
 * not "does the happy path work" but which probe failures should silently take the USB road
 * and which should ask first.
 */

export type FlashRoute =
    /** Flash through the probe over SWD — the normal path. */
    | 'probe'
    /** BOOTSEL + USB mass storage. */
    | 'usb';

/**
 * `chip-not-autodetected` deserves a note: on RP235x, `probe-rs info` fails to identify the
 * chip while flashing works perfectly (we always pass an explicit `--chip`), so it must stay
 * on the probe route.
 *
 * Everything else goes over USB. There is deliberately no separate "ask first" case: when the
 * probe cannot be used, the confirmation dialog before the copy already names the board and
 * states the reason, which is the moment that matters.
 */
export function flashRouteFor(diagnosis: ProbeDiagnosisKind): FlashRoute {
    switch (diagnosis) {
        case 'ok':
        case 'chip-not-autodetected':
            return 'probe';
        case 'none-connected':
        case 'firmware-outdated':
        case 'permission-denied':
        case 'no-target':
        case 'unknown':
            return 'usb';
    }
}

/**
 * Why the USB route is being taken, for the user to read before anything is written. Empty
 * when the probe works, so callers can treat it as "no explanation needed".
 */
export function routeReason(diagnosis: ProbeDiagnosisKind): string {
    switch (diagnosis) {
        case 'ok':
        case 'chip-not-autodetected':
            return '';
        case 'none-connected':
            return 'No debug probe is connected.';
        case 'firmware-outdated':
            return 'The debug probe firmware is too old for probe-rs to open it.';
        case 'permission-denied':
            return 'USB permissions are missing, so the probe cannot be opened.';
        case 'no-target':
            return 'The probe is connected but no target answered on SWD.';
        default:
            return 'The debug probe could not be used.';
    }
}

/**
 * The UF2 family a project's images need, from the detected board or — if the project is not
 * one of ours — from the chip id probe-rs is configured with.
 */
export function uf2FamilyForProject(
    board: BoardProfile | undefined,
    chip: string | undefined,
): number | undefined {
    if (board) {
        return uf2FamilyForBoard(board);
    }
    const id = (chip ?? '').trim().toUpperCase();
    if (id.startsWith('RP2040')) {
        return UF2_FAMILIES.rp2040;
    }
    if (id.startsWith('RP235')) {
        return UF2_FAMILIES.rp2350ArmSecure;
    }
    return undefined;
}

/**
 * The inverse: which silicon a family ID expects to find in BOOTSEL mode. Used to warn when
 * one board's firmware is about to be written to another board.
 */
export function siliconForUf2Family(familyId: number): SiliconFamily {
    if (familyId === UF2_FAMILIES.rp2040) {
        return 'rp2040';
    }
    if (familyId === UF2_FAMILIES.rp2350ArmSecure) {
        return 'rp2350';
    }
    // `rp2xxxAbsolute` is deliberately accepted by both boot ROMs, so it says nothing about
    // the silicon underneath — better to admit that than to guess.
    return 'unknown';
}
