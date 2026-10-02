'use strict';

/**
 * ELF -> UF2 conversion, which the "flash with no debug probe" path depends on.
 *
 * A wrong conversion here is nasty rather than loud: the boot ROM accepts the file, the
 * board reboots, and nothing happens. So these cases pin the format and the address rules
 * rather than just checking that a buffer comes back.
 */

const { test, ok, equal, notOk, contains, throws } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    UF2_MAGIC_START0,
    UF2_MAGIC_START1,
    UF2_MAGIC_END,
    UF2_FLAG_FAMILY_ID,
    UF2_BLOCK_SIZE,
    UF2_PAYLOAD_SIZE,
    UF2_FAMILIES,
    readElfFlashImage,
    mergeSegments,
    buildUf2,
    decodeUf2,
    elfToUf2,
    uf2FamilyForBoard,
    uf2FamilyForFamily,
    familyNameForId,
} = compiled('flash/uf2');
const { boardById } = compiled('boards/catalog');

/**
 * Builds a minimal, valid ELF32 little-endian file carrying the given PT_LOAD segments.
 * `address` is the load address (p_paddr); `vaddr` defaults to it.
 */
function makeElf32(segments, { entry = 0x1000013d } = {}) {
    const phoff = 0x34;
    const phentsize = 32;
    let cursor = phoff + segments.length * phentsize;
    const placed = segments.map((segment) => {
        const at = cursor;
        cursor += segment.data.length;
        return { ...segment, at };
    });

    const elf = Buffer.alloc(cursor);
    elf.write('\u007fELF', 0, 'latin1');
    elf.writeUInt8(1, 4); // ELFCLASS32
    elf.writeUInt8(1, 5); // ELFDATA2LSB
    elf.writeUInt8(1, 6); // EV_CURRENT
    elf.writeUInt16LE(2, 16); // ET_EXEC
    elf.writeUInt16LE(40, 18); // EM_ARM
    elf.writeUInt32LE(1, 20);
    elf.writeUInt32LE(entry, 24);
    elf.writeUInt32LE(phoff, 28);
    elf.writeUInt16LE(52, 40);
    elf.writeUInt16LE(phentsize, 42);
    elf.writeUInt16LE(segments.length, 44);

    placed.forEach((segment, index) => {
        const at = phoff + index * phentsize;
        elf.writeUInt32LE(1, at); // PT_LOAD
        elf.writeUInt32LE(segment.at, at + 4);
        elf.writeUInt32LE(segment.vaddr ?? segment.address, at + 8);
        elf.writeUInt32LE(segment.address, at + 12);
        elf.writeUInt32LE(segment.data.length, at + 16);
        elf.writeUInt32LE(segment.memsz ?? segment.data.length, at + 20);
        elf.writeUInt32LE(segment.flags ?? 5, at + 24);
        elf.writeUInt32LE(4, at + 28);
        segment.data.copy(elf, segment.at);
    });
    return elf;
}

/** Bytes 0..n, a recognisable pattern per segment. */
function pattern(length, seed) {
    return Buffer.from(Array.from({ length }, (_, i) => (i + seed) & 0xff));
}

/** The message a call throws, for asserting on rejections. */
function messageOf(fn) {
    try {
        fn();
        return '(no error thrown)';
    } catch (error) {
        return error.message;
    }
}

/** address -> byte map, so two images can be compared as memory rather than as files. */
function imageMap(segments) {
    const map = new Map();
    for (const segment of segments) {
        for (let i = 0; i < segment.data.length; i += 1) {
            map.set(segment.address + i, segment.data[i]);
        }
    }
    return map;
}

test('a real-shaped image round-trips through UF2 unchanged', () => {
    // The shape our Pico 2 W blinky actually has: three contiguous parts plus .data.
    const image = [
        { address: 0x10000000, data: pattern(0x13c, 1) },
        { address: 0x1000013c, data: pattern(0x9f3c, 2) },
        { address: 0x1000a078, data: pattern(0x3b2ec, 3) },
        { address: 0x10045364, data: pattern(0x38, 4) },
    ];
    const elf = makeElf32(image);
    const { uf2 } = elfToUf2(elf, UF2_FAMILIES.rp2350ArmSecure);
    const decoded = decodeUf2(uf2);

    equal(decoded.familyId, UF2_FAMILIES.rp2350ArmSecure);
    equal(decoded.segments.length, 1, 'contiguous parts must become one run');
    equal(decoded.segments[0].address, 0x10000000);

    const expected = imageMap(image);
    const actual = imageMap(decoded.segments);
    for (const [address, byte] of expected) {
        equal(actual.get(address), byte, `byte at ${address.toString(16)}`);
    }
    equal(actual.size >= expected.size, true);
});

test('the load address is used, never the virtual address', () => {
    // .data lives in flash but runs from RAM: p_paddr 0x10045364, p_vaddr 0x20000000.
    // Placing this block at the virtual address yields a board that writes fine and never boots.
    const elf = makeElf32([
        { address: 0x10000000, data: pattern(0x40, 1) },
        { address: 0x10045364, vaddr: 0x20000000, data: pattern(0x38, 9), memsz: 0x38, flags: 6 },
    ]);
    const { uf2, image } = elfToUf2(elf, UF2_FAMILIES.rp2350ArmSecure);

    equal(image.segments[1].address, 0x10045364);
    const decoded = decodeUf2(uf2);
    const addresses = decoded.segments.map((segment) => segment.address);
    equal(addresses.includes(0x10045364), true, `expected a block at 0x10045364, got ${addresses.map((a) => a.toString(16)).join(', ')}`);
    equal(addresses.includes(0x20000000), false, 'no block may target a RAM address');
});

test('every block is 512 bytes with the documented magic and family flag', () => {
    const elf = makeElf32([{ address: 0x10000000, data: pattern(600, 1) }]);
    const uf2 = buildUf2(readElfFlashImage(elf).segments, UF2_FAMILIES.rp2040);

    equal(uf2.length % UF2_BLOCK_SIZE, 0);
    const blocks = uf2.length / UF2_BLOCK_SIZE;
    equal(blocks, 3, '600 bytes needs 256 + 256 + 88');

    for (let index = 0; index < blocks; index += 1) {
        const at = index * UF2_BLOCK_SIZE;
        equal(uf2.readUInt32LE(at), UF2_MAGIC_START0);
        equal(uf2.readUInt32LE(at + 4), UF2_MAGIC_START1);
        equal(uf2.readUInt32LE(at + UF2_BLOCK_SIZE - 4), UF2_MAGIC_END);
        equal(uf2.readUInt32LE(at + 8), UF2_FLAG_FAMILY_ID, 'the family flag is what makes RP2xxx boot ROMs accept it');
        equal(uf2.readUInt32LE(at + 16), UF2_PAYLOAD_SIZE);
        equal(uf2.readUInt32LE(at + 20), index, 'block numbers count from zero, in order');
        equal(uf2.readUInt32LE(at + 24), blocks);
        equal(uf2.readUInt32LE(at + 12), 0x10000000 + index * UF2_PAYLOAD_SIZE, 'blocks ascend through the flash address');
    }
});

test('a short final block is zero padded, not truncated', () => {
    const elf = makeElf32([{ address: 0x10000000, data: pattern(300, 7) }]);
    const uf2 = buildUf2(readElfFlashImage(elf).segments, UF2_FAMILIES.rp2040);
    const blocks = uf2.length / UF2_BLOCK_SIZE;
    equal(blocks, 2);

    const tail = uf2.subarray(UF2_BLOCK_SIZE + 32, 2 * UF2_BLOCK_SIZE - 4);
    equal(tail.length, 476, 'the payload area of a block');
    equal(tail.subarray(44, 256).every((byte) => byte === 0), true, 'the padding must be zero');
    equal(tail[43], (299 + 7) & 0xff, 'the last real byte still lands where it belongs');
});

test('gaps between segments survive; contiguous ones are joined', () => {
    const merged = mergeSegments([
        { address: 0x10000200, data: Buffer.from([1, 2]) },
        { address: 0x10000000, data: Buffer.from([3, 4]) },
        { address: 0x10000002, data: Buffer.from([5, 6]) },
    ]);
    equal(
        merged.map((segment) => [segment.address, segment.data.length]),
        [
            [0x10000000, 4],
            [0x10000200, 2],
        ],
    );
});

test('overlapping segments are refused instead of guessed at', () => {
    throws(
        () =>
            mergeSegments([
                { address: 0x10000000, data: Buffer.alloc(16) },
                { address: 0x10000008, data: Buffer.alloc(16) },
            ]),
        'an overlap must be reported, not silently resolved',
    );
});

test('segments with no file bytes (.bss) contribute nothing', () => {
    const elf = makeElf32([
        { address: 0x10000000, data: pattern(16, 1) },
        { address: 0x20000000, data: Buffer.alloc(0), memsz: 0x4e40, flags: 6 },
    ]);
    const image = readElfFlashImage(elf);
    equal(image.segments.length, 1);
    equal(image.segments[0].address, 0x10000000);
});

test('the family IDs match the boot ROM headers', () => {
    equal(UF2_FAMILIES.rp2040, 0xe48bff56, 'RP2040_FAMILY_ID, pico-sdk boot/uf2.h');
    equal(UF2_FAMILIES.rp2xxxAbsolute, 0xe48bff57, 'ABSOLUTE_FAMILY_ID, pico-sdk boot/uf2.h');
    equal(UF2_FAMILIES.rp2350ArmSecure, 0xe48bff59, 'RP2350_ARM_S, microsoft/uf2 uf2families.json');
    equal(familyNameForId(0xe48bff59), 'rp2350ArmSecure');
    notOk(familyNameForId(0x12345678));
});

test('each board gets the family its silicon needs', () => {
    equal(uf2FamilyForFamily('RP2040'), UF2_FAMILIES.rp2040);
    equal(uf2FamilyForFamily('RP2350'), UF2_FAMILIES.rp2350ArmSecure);
    for (const id of ['pico', 'picow']) {
        equal(uf2FamilyForBoard(boardById(id)), UF2_FAMILIES.rp2040, id);
    }
    for (const id of ['pico2', 'pico2w']) {
        equal(uf2FamilyForBoard(boardById(id)), UF2_FAMILIES.rp2350ArmSecure, id);
    }
});

test('junk, truncation and ELF64 are rejected with a reason', () => {
    contains(
        messageOf(() => readElfFlashImage(Buffer.from('nope'))),
        'not an ELF',
        'a file that is not an ELF must say so',
    );

    const elf64 = makeElf32([{ address: 0x10000000, data: pattern(16, 1) }]);
    elf64.writeUInt8(2, 4);
    contains(messageOf(() => readElfFlashImage(elf64)), 'ELF64');

    const truncated = makeElf32([{ address: 0x10000000, data: pattern(64, 1) }]).subarray(0, 80);
    contains(messageOf(() => readElfFlashImage(truncated)), 'program header table');

    const noLoad = makeElf32([{ address: 0x10000000, data: Buffer.alloc(0), memsz: 8 }]);
    contains(messageOf(() => readElfFlashImage(noLoad)), 'nothing to flash');
});

test('a corrupt or truncated UF2 is reported rather than half-read', () => {
    const good = buildUf2([{ address: 0x10000000, data: pattern(300, 1) }], UF2_FAMILIES.rp2040);

    throws(() => decodeUf2(good.subarray(0, good.length - 1)), 'a partial block is not a UF2');
    throws(() => decodeUf2(Buffer.alloc(0)), 'an empty file is not a UF2');

    const badMagic = Buffer.from(good);
    badMagic.writeUInt32LE(0xdeadbeef, 0);
    throws(() => decodeUf2(badMagic), 'a broken start magic must be caught');

    const noFamily = Buffer.from(good);
    noFamily.writeUInt32LE(0, 8);
    throws(() => decodeUf2(noFamily), 'blocks without a family ID are ignored by the boot ROM');
});

test('a UF2 is the whole image, not a fragment', () => {
    const image = [{ address: 0x10000000, data: pattern(1000, 1) }];
    const uf2 = elfToUf2(makeElf32(image), UF2_FAMILIES.rp2040).uf2;
    const decoded = decodeUf2(uf2);

    equal(decoded.blockCount, 4, '1000 bytes -> 256, 256, 256, 232');
    const map = imageMap(decoded.segments);
    for (let i = 0; i < 1000; i += 1) {
        equal(map.get(0x10000000 + i), (i + 1) & 0xff, `byte ${i}`);
    }
});
