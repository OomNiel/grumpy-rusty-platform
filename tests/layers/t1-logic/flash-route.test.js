'use strict';

/**
 * Which route a flash takes. The interesting cases are the probe failures: some can be
 * worked around over USB without asking, others have to be surfaced first — and
 * `chip-not-autodetected` must never touch the USB path, because it is the *normal* result on
 * RP235x where flashing through the probe works perfectly well.
 */

const { test, ok, equal, notOk, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { flashRouteFor, routeReason, uf2FamilyForProject, siliconForUf2Family } = compiled('flash/route');
const { UF2_FAMILIES } = compiled('flash/uf2');
const { boardById } = compiled('boards/catalog');

test('a working probe is always the preferred route', () => {
    equal(flashRouteFor('ok'), 'probe');
    equal(
        flashRouteFor('chip-not-autodetected'),
        'probe',
        'probe-rs cannot auto-detect RP235x, but flashing with an explicit chip works',
    );
});

test('with no probe at all, USB is the only road', () => {
    equal(flashRouteFor('none-connected'), 'usb');
});

test('a probe that exists but cannot be used also takes the USB road', () => {
    for (const kind of ['firmware-outdated', 'permission-denied', 'probe-busy', 'no-target', 'unknown']) {
        equal(flashRouteFor(kind), 'usb', kind);
    }
});

test('the USB road always explains itself; the probe road has nothing to explain', () => {
    const kinds = [
        'ok',
        'chip-not-autodetected',
        'none-connected',
        'firmware-outdated',
        'permission-denied',
        'probe-busy',
        'no-target',
        'unknown',
    ];
    for (const kind of kinds) {
        ok(flashRouteFor(kind), `${kind} has no route`);
    }

    equal(routeReason('ok'), '', 'nothing to explain when the probe works');
    equal(routeReason('chip-not-autodetected'), '', 'flashing through the probe works on RP235x');

    for (const kind of ['none-connected', 'firmware-outdated', 'permission-denied', 'no-target', 'unknown']) {
        ok(routeReason(kind).length > 10, `${kind} has no explanation`);
    }
    contains(routeReason('no-target'), 'SWD');
    contains(routeReason('permission-denied'), 'permissions');
    contains(routeReason('none-connected'), 'No debug probe');
    // The one that used to read as a hardware fault: name what is actually holding it.
    contains(routeReason('probe-busy'), 'holding the debug probe');
    contains(routeReason('probe-busy'), 'Close it first');
});

test('the UF2 family comes from the board when we recognise it', () => {
    equal(uf2FamilyForProject(boardById('pico'), undefined), UF2_FAMILIES.rp2040);
    equal(uf2FamilyForProject(boardById('picow'), undefined), UF2_FAMILIES.rp2040);
    equal(uf2FamilyForProject(boardById('pico2'), undefined), UF2_FAMILIES.rp2350ArmSecure);
    equal(uf2FamilyForProject(boardById('pico2w'), undefined), UF2_FAMILIES.rp2350ArmSecure);
});

test('the chip id is the fallback for projects that are not ours', () => {
    equal(uf2FamilyForProject(undefined, 'RP235x'), UF2_FAMILIES.rp2350ArmSecure);
    equal(uf2FamilyForProject(undefined, 'RP2040'), UF2_FAMILIES.rp2040);
    equal(uf2FamilyForProject(undefined, '  rp235x  '), UF2_FAMILIES.rp2350ArmSecure, 'spacing and case tolerated');
    notOk(uf2FamilyForProject(undefined, undefined), 'an unknown chip must not be guessed at');
    notOk(uf2FamilyForProject(undefined, ''));
    notOk(uf2FamilyForProject(undefined, 'STM32F4'), 'a foreign chip is not our business');
});

test('a family can be turned back into silicon, for the mismatch warning', () => {
    equal(siliconForUf2Family(UF2_FAMILIES.rp2040), 'rp2040');
    equal(siliconForUf2Family(UF2_FAMILIES.rp2350ArmSecure), 'rp2350');
    equal(
        siliconForUf2Family(UF2_FAMILIES.rp2xxxAbsolute),
        'unknown',
        'both boot ROMs accept this one, so it says nothing about the silicon',
    );
    equal(siliconForUf2Family(0x1234), 'unknown');
});
