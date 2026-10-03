import * as path from 'path';
import { RpBoardProfile, RpFamily } from '../boards/types';

/**
 * Turning a built ELF into the UF2 file the RP2040/RP2350 boot ROM accepts.
 *
 * This exists for the user with **no debug probe**: they flash by dragging a file onto the
 * board's BOOTSEL volume. Such a user has the least tooling, which is why we do the
 * conversion here instead of shelling out — `picotool` publishes no prebuilt Linux binary
 * (release assets are source tarballs only) and `elf2uf2-rs` would be one more install
 * step. Doing it ourselves keeps it offline and testable.
 *
 * UF2 block, 512 bytes, all fields little-endian:
 *
 *   0x000  magicStart0  0x0A324655
 *   0x004  magicStart1  0x9E5D5157
 *   0x008  flags        bit 0x2000 => the familyID field really holds a family ID
 *   0x00C  targetAddr   absolute address in FLASH
 *   0x010  payloadSize  how many bytes of `data` are valid
 *   0x014  blockNo
 *   0x018  numBlocks
 *   0x01C  familyID
 *   0x020  data[476]
 *   0x1FC  magicEnd     0x0AB16F30
 */

export const UF2_MAGIC_START0 = 0x0a324655;
export const UF2_MAGIC_START1 = 0x9e5d5157;
export const UF2_MAGIC_END = 0x0ab16f30;
export const UF2_FLAG_FAMILY_ID = 0x00002000;
export const UF2_BLOCK_SIZE = 512;
/** A block has room for 476 bytes, but 256 is what elf2uf2/picotool emit and what every boot ROM is known-good with. */
export const UF2_PAYLOAD_SIZE = 256;

/**
 * Family IDs, taken from two sources rather than memory:
 * `pico-sdk/src/common/boot_uf2_headers/include/boot/uf2.h` and the UF2 project's registry
 * (`microsoft/uf2`, `utils/uf2families.json`).
 */
export const UF2_FAMILIES = {
    /** RP2040 boot ROM — a Pico 1 / Pico W. */
    rp2040: 0xe48bff56,
    /** "Absolute (unpartitioned) download", understood by both boot ROMs. */
    rp2xxxAbsolute: 0xe48bff57,
    /**
     * RP2350 secure Arm image. This is what a Pico 2 wants for our builds: `arm-none-eabi`
     * code plus `embassy-rp`'s `binary-info` feature, which puts an IMAGE_DEF in the image.
     */
    rp2350ArmSecure: 0xe48bff59,
} as const;

/** A run of bytes destined for a flash address. */
export interface Uf2Segment {
    address: number;
    data: Buffer;
}

export interface ElfFlashImage {
    /** `e_entry`, for diagnostics. */
    entry: number;
    segments: Uf2Segment[];
}

/** The UF2 family a board's images belong to. */
export function uf2FamilyForFamily(family: RpFamily): number {
    return family === 'RP2040' ? UF2_FAMILIES.rp2040 : UF2_FAMILIES.rp2350ArmSecure;
}

export function uf2FamilyForBoard(board: RpBoardProfile): number {
    return uf2FamilyForFamily(board.family);
}

/** The family ID names we accept, for messages and tests. */
export function familyNameForId(id: number): string | undefined {
    return Object.entries(UF2_FAMILIES).find(([, value]) => value === id)?.[0];
}

// ------------------------------------------------------------------ ELF reading

function fail(message: string): never {
    throw new Error(message);
}

/**
 * Reads the parts of an ELF that belong in flash.
 *
 * Only `PT_LOAD` program headers with file bytes are used, and they are placed at
 * **`p_paddr`** — the load address. That detail matters more than it looks: for `.data`,
 * `p_vaddr` is the RAM address the bytes are copied *to* (e.g. `0x20000000`) while
 * `p_paddr` is where they live in flash. Placing blocks at the virtual address would
 * produce an image the boot ROM happily writes and the CPU can never run.
 */
export function readElfFlashImage(elf: Buffer): ElfFlashImage {
    if (elf.length < 52) {
        fail(`not an ELF file: only ${elf.length} bytes`);
    }
    if (elf[0] !== 0x7f || elf[1] !== 0x45 || elf[2] !== 0x4c || elf[3] !== 0x46) {
        fail('not an ELF file: bad magic number');
    }
    const elfClass = elf.readUInt8(4);
    if (elfClass === 2) {
        fail('this is an ELF64 file; every supported board is a 32-bit target, so this should not happen');
    }
    if (elfClass !== 1) {
        fail(`unsupported ELF class ${elfClass}`);
    }
    if (elf.readUInt8(5) !== 1) {
        fail('only little-endian ELF files are supported');
    }

    const entry = elf.readUInt32LE(24);
    const phoff = elf.readUInt32LE(28);
    const phentsize = elf.readUInt16LE(42);
    const phnum = elf.readUInt16LE(44);

    if (phnum === 0xffff) {
        // PN_XNUM: the real count lives in the section header table, which we do not parse.
        fail('this ELF uses PN_XNUM; the real program header count is in section 0, which is not supported');
    }
    if (phnum === 0 || phentsize < 32) {
        fail(`ELF has no usable program headers (phnum ${phnum}, phentsize ${phentsize})`);
    }
    if (phoff + phnum * phentsize > elf.length) {
        fail('ELF program header table extends past the end of the file');
    }

    const segments: Uf2Segment[] = [];
    for (let index = 0; index < phnum; index += 1) {
        const header = phoff + index * phentsize;
        const type = elf.readUInt32LE(header);
        if (type !== 1) {
            continue; // not PT_LOAD
        }
        const offset = elf.readUInt32LE(header + 4);
        const paddr = elf.readUInt32LE(header + 12);
        const filesz = elf.readUInt32LE(header + 16);
        if (filesz === 0) {
            continue; // .bss and friends: reserved, nothing to write
        }
        if (offset + filesz > elf.length) {
            fail(`ELF segment ${index} claims ${filesz} bytes at ${offset}, past the end of the file`);
        }
        segments.push({ address: paddr, data: elf.subarray(offset, offset + filesz) });
    }

    if (segments.length === 0) {
        fail('ELF contains no loadable segments with file bytes — nothing to flash');
    }
    return { entry, segments };
}

/**
 * Sorts segments by address and joins those that meet exactly, so a normal linked image
 * (several headers describing one contiguous run) becomes a single run. An overlap is
 * reported instead of guessed at: silently choosing one would mean quietly corrupting an
 * image.
 */
export function mergeSegments(segments: Uf2Segment[]): Uf2Segment[] {
    const sorted = [...segments].sort((a, b) => a.address - b.address);
    const merged: Uf2Segment[] = [];
    for (const segment of sorted) {
        const previous = merged[merged.length - 1];
        if (!previous) {
            merged.push({ address: segment.address, data: Buffer.from(segment.data) });
            continue;
        }
        const previousEnd = previous.address + previous.data.length;
        if (segment.address === previousEnd) {
            previous.data = Buffer.concat([previous.data, segment.data]);
            continue;
        }
        if (segment.address < previousEnd) {
            fail(
                `ELF segments overlap: one ends at ${previousEnd.toString(16)}, the next starts at ` +
                `${segment.address.toString(16)}`,
            );
        }
        merged.push({ address: segment.address, data: Buffer.from(segment.data) });
    }
    return merged;
}

// ------------------------------------------------------------------ UF2 writing

/**
 * Writes the flash image as UF2 blocks: 256-byte payloads in ascending address order, the
 * final block of a run zero-padded so every payload is the same size.
 */
export function buildUf2(segments: Uf2Segment[], familyId: number): Buffer {
    const runs = mergeSegments(segments);
    const blocks: { address: number; payload: Buffer }[] = [];

    for (const run of runs) {
        for (let offset = 0; offset < run.data.length; offset += UF2_PAYLOAD_SIZE) {
            const payload = Buffer.alloc(UF2_PAYLOAD_SIZE);
            run.data.copy(payload, 0, offset, Math.min(offset + UF2_PAYLOAD_SIZE, run.data.length));
            blocks.push({ address: run.address + offset, payload });
        }
    }
    if (blocks.length === 0) {
        fail('nothing to write: the flash image is empty');
    }

    const out = Buffer.alloc(blocks.length * UF2_BLOCK_SIZE);
    blocks.forEach((block, index) => {
        const at = index * UF2_BLOCK_SIZE;
        out.writeUInt32LE(UF2_MAGIC_START0, at);
        out.writeUInt32LE(UF2_MAGIC_START1, at + 4);
        out.writeUInt32LE(UF2_FLAG_FAMILY_ID, at + 8);
        out.writeUInt32LE(block.address, at + 12);
        out.writeUInt32LE(UF2_PAYLOAD_SIZE, at + 16);
        out.writeUInt32LE(index, at + 20);
        out.writeUInt32LE(blocks.length, at + 24);
        out.writeUInt32LE(familyId, at + 28);
        block.payload.copy(out, at + 32);
        out.writeUInt32LE(UF2_MAGIC_END, at + UF2_BLOCK_SIZE - 4);
    });
    return out;
}

/** Reads a UF2 back into a flash image. Used by the tests and for diagnostics. */
export function decodeUf2(uf2: Buffer): { familyId: number; segments: Uf2Segment[]; blockCount: number } {
    if (uf2.length === 0 || uf2.length % UF2_BLOCK_SIZE !== 0) {
        fail(`a UF2 file is a whole number of ${UF2_BLOCK_SIZE}-byte blocks; got ${uf2.length} bytes`);
    }
    const blockCount = uf2.length / UF2_BLOCK_SIZE;
    const parts: Uf2Segment[] = [];
    let familyId: number | undefined;

    for (let index = 0; index < blockCount; index += 1) {
        const at = index * UF2_BLOCK_SIZE;
        if (uf2.readUInt32LE(at) !== UF2_MAGIC_START0 || uf2.readUInt32LE(at + 4) !== UF2_MAGIC_START1) {
            fail(`block ${index}: bad start magic`);
        }
        if (uf2.readUInt32LE(at + UF2_BLOCK_SIZE - 4) !== UF2_MAGIC_END) {
            fail(`block ${index}: bad end magic`);
        }
        const flags = uf2.readUInt32LE(at + 8);
        if ((flags & UF2_FLAG_FAMILY_ID) === 0) {
            fail(`block ${index}: no family ID, which an RP2xxx boot ROM will ignore`);
        }
        const address = uf2.readUInt32LE(at + 12);
        const payloadSize = uf2.readUInt32LE(at + 16);
        const blockNo = uf2.readUInt32LE(at + 20);
        const total = uf2.readUInt32LE(at + 24);
        if (blockNo !== index || total !== blockCount) {
            fail(`block ${index}: numbering says ${blockNo} of ${total}`);
        }
        if (payloadSize === 0 || payloadSize > 476) {
            fail(`block ${index}: implausible payload size ${payloadSize}`);
        }
        const thisFamily = uf2.readUInt32LE(at + 28);
        if (familyId === undefined) {
            familyId = thisFamily;
        } else if (familyId !== thisFamily) {
            fail(`block ${index}: family ID changes mid-file`);
        }
        parts.push({ address, data: uf2.subarray(at + 32, at + 32 + payloadSize) });
    }

    return { familyId: familyId ?? 0, segments: mergeSegments(parts), blockCount };
}

/** Convenience: ELF bytes in, UF2 bytes out. */
export function elfToUf2(elf: Buffer, familyId: number): { uf2: Buffer; image: ElfFlashImage } {
    const image = readElfFlashImage(elf);
    return { uf2: buildUf2(image.segments, familyId), image };
}

/**
 * Where a converted image is written: a `dist/` folder at the project root, rather than next
 * to the ELF inside `target/`. A user who has to hold a button while plugging a board in
 * should not lose the file to a `cargo clean`, and `dist/` is the conventional place to look.
 */
export function distUf2Path(projectDir: string, elfPath: string): string {
    const name = path.basename(elfPath);
    return path.join(projectDir, 'dist', name.endsWith('.uf2') ? name : `${name}.uf2`);
}
