/**
 * DIDEVCAPS.dwDevType belongs to the generation that asked, not to the device.
 *
 * dinput8 reports DI8DEVTYPE_* (0x11..0x15); dinput<=7 reports DIDEVTYPE_* (1..5). They
 * are disjoint, and a DI8 engine routinely dispatches its buffered reads on the value —
 * The Bard's Tale computes `type - DI8DEVTYPE_MOUSE` and discards anything above 3. Given
 * the legacy constant it read every device as unclassifiable and dropped 100% of its
 * input, while acquisition, the message queue, the event counts and the frame loop all
 * looked healthy. That is why this is pinned as a contract rather than left to a comment.
 */
import { describe, expect, test } from "bun:test";
import { deviceTypeConstant } from "../../src/worker/modules/dinput/dinput";

const DI8 = true;
const LEGACY = false;

describe("DirectInput device-type constants follow the interface generation", () => {
    test("dinput8 answers the DI8DEVTYPE_* family", () => {
        expect(deviceTypeConstant("mouse", DI8)).toBe(0x12);
        expect(deviceTypeConstant("keyboard", DI8)).toBe(0x13);
        expect(deviceTypeConstant("joystick", DI8)).toBe(0x14);
        expect(deviceTypeConstant("gamepad", DI8)).toBe(0x15);
        expect(deviceTypeConstant("unknown", DI8)).toBe(0x11);
    });

    test("dinput<=7 answers the legacy DIDEVTYPE_* family", () => {
        expect(deviceTypeConstant("mouse", LEGACY)).toBe(2);
        expect(deviceTypeConstant("keyboard", LEGACY)).toBe(3);
        expect(deviceTypeConstant("joystick", LEGACY)).toBe(4);
        expect(deviceTypeConstant("gamepad", LEGACY)).toBe(5);
        expect(deviceTypeConstant("unknown", LEGACY)).toBe(1);
    });

    test("the two families are disjoint — neither can be mistaken for the other", () => {
        const kinds = ["mouse", "keyboard", "joystick", "gamepad", "unknown"];
        const di8 = kinds.map((k) => deviceTypeConstant(k, DI8));
        const legacy = kinds.map((k) => deviceTypeConstant(k, LEGACY));
        for (const v of di8) expect(legacy).not.toContain(v);
    });

    test("the DI8 values survive the dispatch a DI8 engine actually performs", () => {
        // `movzx eax,cl; add eax,-0x12; cmp eax,3; ja <discard>` — the exe's own switch.
        for (const kind of ["mouse", "keyboard", "joystick", "gamepad"]) {
            const idx = (deviceTypeConstant(kind, DI8) & 0xff) - 0x12;
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThanOrEqual(3);
        }
        // The legacy family is exactly what that dispatch throws away.
        for (const kind of ["mouse", "keyboard", "joystick", "gamepad"]) {
            const idx = ((deviceTypeConstant(kind, LEGACY) & 0xff) - 0x12) >>> 0;
            expect(idx).toBeGreaterThan(3);
        }
    });
});
