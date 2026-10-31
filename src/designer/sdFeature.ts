/**
 * The `sd` cargo feature of a Designer project.
 *
 * `src/designer/features.ts` holds the editing rules -- the SD switch lives here, so
 * the parsing lives in one place. What is SD-specific is the meaning: `sd` is `embedded-sdmmc` (a FAT
 * filesystem) plus the `critical-section` mutex `src/sd.rs` keeps the mounted volume behind; both are declared
 * `optional` and pulled in by the feature. It is in `default`, which is what ships every Designer project with
 * the card on; the toolbar's switch is what moves it out of `default` to turn the card off, and back in again.
 */

import { isFeatureInDefault, setFeatureInDefault } from './features';

/** True when the project's `default` feature list enables `sd`. */
export function isSdEnabled(cargoToml: string): boolean {
    return isFeatureInDefault(cargoToml, 'sd');
}

/**
 * Turns the `sd` feature on or off in `default`, returning the new manifest and what changed.
 *
 * `none` when the file has no `[features]` of its own (a project whose board has no card, or one generated
 * before the feature existed) or when the setting is already where it was asked to be.
 */
export function setSdEnabled(
    cargoToml: string,
    enabled: boolean,
): { text: string; note: 'added' | 'removed' | 'none' } {
    return setFeatureInDefault(cargoToml, 'sd', enabled);
}
