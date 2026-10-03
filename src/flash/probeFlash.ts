/**
 * The command a probe flash runs.
 *
 * `cargo run` — what the Flash button used to do — flashes and then *keeps the probe open*: the
 * runner in `.cargo/config.toml` is `probe-rs run`, which attaches and streams defmt over RTT. The
 * probe stays claimed until that terminal is closed, so the next debug session fails with "The
 * selected USB device could not be opened" and reads like a hardware fault. Flash is a one-shot
 * write instead: `download` puts the ELF on the chip, `reset` starts it, both exit, and the probe is
 * free again. Streaming defmt output is what the Monitor button is for.
 *
 * Pure, so the shape of the command is pinned by a test rather than by reading the command chain.
 */

/** `probe-rs download --chip RP235x "<elf>" && probe-rs reset --chip RP235x` */
export function probeFlashCommand(probeRs: string, chip: string, elfPath: string): string {
    return `${probeRs} download --chip ${chip} ${quotePath(elfPath)} && ${probeRs} reset --chip ${chip}`;
}

/** Double quotes: they survive POSIX shells and PowerShell alike, and project paths contain spaces. */
export function quotePath(elfPath: string): string {
    return `"${elfPath.replace(/"/g, '\\"')}"`;
}
