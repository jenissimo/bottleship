/**
 * MapVirtualKey: the four MAPVK_* directions, and the one invariant that keeps the
 * layout table honest — the scan code MapVirtualKey hands out for a VK must be the
 * scan code the input path stamps into that key's WM_KEYDOWN lParam. Two tables
 * describing one keyboard is exactly how this went wrong before (letters were
 * computed alphabetically, `vk - 'A' + 0x1E`).
 */
import { describe, expect, test } from "bun:test";
import { createSystemExports } from "../../src/worker/modules/user32/system";
import { vkToScanCode } from "../../src/worker/runtime/input/input-manager";

const MAPVK_VK_TO_VSC = 0;
const MAPVK_VSC_TO_VK = 1;
const MAPVK_VK_TO_CHAR = 2;
const MAPVK_VSC_TO_VK_EX = 3;
const MAPVK_VK_TO_VSC_EX = 4;

const exports = createSystemExports();
const mapVirtualKey = (code: number, type: number): number =>
    exports["MapVirtualKeyA"]!(null as never, null as never, [code, type] as never) as number;

describe("MapVirtualKey", () => {
    test("VK_TO_VSC uses physical Set-1 order, not alphabetical", () => {
        expect(mapVirtualKey(0x41, MAPVK_VK_TO_VSC)).toBe(0x1e); // 'A'
        expect(mapVirtualKey(0x57, MAPVK_VK_TO_VSC)).toBe(0x11); // 'W'
        expect(mapVirtualKey(0x42, MAPVK_VK_TO_VSC)).toBe(0x30); // 'B'
        expect(mapVirtualKey(0x5a, MAPVK_VK_TO_VSC)).toBe(0x2c); // 'Z'
    });

    test("VSC_TO_VK_EX (type 3) is scan→VK with sided modifiers", () => {
        expect(mapVirtualKey(0x11, MAPVK_VSC_TO_VK_EX)).toBe(0x57); // 'W'
        expect(mapVirtualKey(0x2a, MAPVK_VSC_TO_VK_EX)).toBe(0xa0); // VK_LSHIFT
        expect(mapVirtualKey(0x36, MAPVK_VSC_TO_VK_EX)).toBe(0xa1); // VK_RSHIFT
        expect(mapVirtualKey(0x1d, MAPVK_VSC_TO_VK_EX)).toBe(0xa2); // VK_LCONTROL
        expect(mapVirtualKey(0x38, MAPVK_VSC_TO_VK_EX)).toBe(0xa4); // VK_LMENU
        expect(mapVirtualKey(0xe01d, MAPVK_VSC_TO_VK_EX)).toBe(0xa3); // VK_RCONTROL
        expect(mapVirtualKey(0xe038, MAPVK_VSC_TO_VK_EX)).toBe(0xa5); // VK_RMENU
    });

    test("VSC_TO_VK (type 1) folds the sides away", () => {
        expect(mapVirtualKey(0x2a, MAPVK_VSC_TO_VK)).toBe(0x10); // VK_SHIFT
        expect(mapVirtualKey(0x36, MAPVK_VSC_TO_VK)).toBe(0x10);
        expect(mapVirtualKey(0x1d, MAPVK_VSC_TO_VK)).toBe(0x11); // VK_CONTROL
        expect(mapVirtualKey(0x38, MAPVK_VSC_TO_VK)).toBe(0x12); // VK_MENU
        expect(mapVirtualKey(0x11, MAPVK_VSC_TO_VK)).toBe(0x57); // non-modifier unchanged
    });

    test("VK_TO_VSC_EX prefixes 0xE0 only for keys that exist solely as E0", () => {
        expect(mapVirtualKey(0xa3, MAPVK_VK_TO_VSC_EX)).toBe(0xe01d); // VK_RCONTROL
        expect(mapVirtualKey(0xa3, MAPVK_VK_TO_VSC)).toBe(0x1d);      // …low byte only
        expect(mapVirtualKey(0x6f, MAPVK_VK_TO_VSC_EX)).toBe(0xe035); // VK_DIVIDE
        expect(mapVirtualKey(0x24, MAPVK_VK_TO_VSC_EX)).toBe(0x47);   // VK_HOME: bare wins
    });

    test("side-agnostic and numpad VKs resolve to the physical key underneath", () => {
        expect(mapVirtualKey(0x10, MAPVK_VK_TO_VSC)).toBe(0x2a); // VK_SHIFT   → LSHIFT
        expect(mapVirtualKey(0x11, MAPVK_VK_TO_VSC)).toBe(0x1d); // VK_CONTROL → LCONTROL
        expect(mapVirtualKey(0x12, MAPVK_VK_TO_VSC)).toBe(0x38); // VK_MENU    → LMENU
        expect(mapVirtualKey(0x67, MAPVK_VK_TO_VSC)).toBe(0x47); // VK_NUMPAD7 → Home key
        expect(mapVirtualKey(0x60, MAPVK_VK_TO_VSC)).toBe(0x52); // VK_NUMPAD0 → Insert key
    });

    test("an unassigned code maps to 0, never to itself", () => {
        expect(mapVirtualKey(0xff, MAPVK_VK_TO_VSC)).toBe(0);
        expect(mapVirtualKey(0x00, MAPVK_VSC_TO_VK_EX)).toBe(0);
        expect(mapVirtualKey(0x55, MAPVK_VSC_TO_VK_EX)).toBe(0); // hole in the table
        expect(mapVirtualKey(0x57, 99)).toBe(0);                 // unknown map type
    });

    test("VK_TO_CHAR keeps letters UPPERCASE", () => {
        expect(mapVirtualKey(0x41, MAPVK_VK_TO_CHAR)).toBe(0x41); // 'A', not 'a'
        expect(mapVirtualKey(0x39, MAPVK_VK_TO_CHAR)).toBe(0x39); // '9'
        expect(mapVirtualKey(0x67, MAPVK_VK_TO_CHAR)).toBe(0x37); // VK_NUMPAD7 → '7'
        expect(mapVirtualKey(0xbf, MAPVK_VK_TO_CHAR)).toBe(0x2f); // VK_OEM_2 → '/'
    });

    test("a scancode sweep answers for every key the layout defines (SS2 builds a table this way)", () => {
        let answered = 0;
        for (let scan = 0; scan <= 0xff; scan++) {
            const vk = mapVirtualKey(scan, MAPVK_VSC_TO_VK_EX);
            if (vk) answered++;
            expect(vk).toBeLessThanOrEqual(0xff);
        }
        expect(answered).toBeGreaterThan(100);
    });

    // The drift guard: one keyboard, two consumers.
    test("VK_TO_VSC agrees with the scan code the input path puts in lParam", () => {
        const vks: number[] = [];
        for (let vk = 0x30; vk <= 0x39; vk++) vks.push(vk);            // digits
        for (let vk = 0x41; vk <= 0x5a; vk++) vks.push(vk);            // letters
        for (let vk = 0x70; vk <= 0x7b; vk++) vks.push(vk);            // F1-F12
        for (let vk = 0x60; vk <= 0x69; vk++) vks.push(vk);            // numpad digits
        vks.push(0x08, 0x09, 0x0d, 0x1b, 0x20,                          // control keys
            0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, // navigation
            0x10, 0x11, 0x12, 0x14, 0x90, 0x91,                         // modifiers/locks
            0x6a, 0x6b, 0x6d, 0x6e, 0x6f,                               // numpad operators
            0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xdb, 0xdc, 0xdd, 0xde);
        const disagreements = vks
            .map((vk) => ({ vk, api: mapVirtualKey(vk, MAPVK_VK_TO_VSC), input: vkToScanCode(vk) }))
            .filter((e) => e.api !== e.input)
            .map((e) => `VK 0x${e.vk.toString(16)}: MapVirtualKey 0x${e.api.toString(16)} ` +
                `vs lParam 0x${e.input.toString(16)}`);
        expect(disagreements).toEqual([]);
    });
});
