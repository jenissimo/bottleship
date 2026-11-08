import { expect, test } from "bun:test";
import { registerWinmmJoystickExports } from "../../src/worker/modules/winmm-joystick";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const JOYERR_PARMS = 165;
const joy: Record<string, ThunkImplementation> = {};
registerWinmmJoystickExports(joy);
const mem = new Uint8Array(0x2000);
new DataView(mem.buffer).setUint32(0x1000, 52, true);
const call = (name: string, ...args: number[]) => joy[name]!({} as never, mem, args) as number;

test("a joystick ID past joyGetNumDevs answers JOYERR_PARMS, which enumeration loops stop on", () => {
    const ports = call("joyGetNumDevs");
    for (const id of [ports, ports + 1, 15]) {
        expect(call("joyGetPosEx", id, 0x1000)).toBe(JOYERR_PARMS);
        expect(call("joyGetPos", id, 0x1000)).toBe(JOYERR_PARMS);
        expect(call("joyGetDevCapsA", id, 0x1100, 404)).toBe(JOYERR_PARMS);
        expect(call("joyGetThreshold", id, 0x1000)).toBe(JOYERR_PARMS);
    }
});
