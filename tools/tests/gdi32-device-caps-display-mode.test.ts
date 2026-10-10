/**
 * GetDeviceCaps on a screen DC reports the CURRENT display mode. A title that switches
 * to 640x480 and then centres a window from HORZRES/VERTRES lands it off-screen when
 * the answer is still the desktop it booted on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { System } from "../../src/worker/core/system";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";

const HORZRES = 8;
const VERTRES = 10;
const BITSPIXEL = 12;

const gdi32 = createPaintingExports();
const caps = (index: number): number => gdi32.GetDeviceCaps!({} as never, new Uint8Array(16), [0x20000, index]) as number;

describe("GetDeviceCaps display mode", () => {
    const system = System.getInstance();
    afterEach(() => { system.emulatedDisplayMode = null; });

    test("the boot desktop until a mode is set", () => {
        EmulatorConfig.getInstance().screenResolution = { width: 1024, height: 768, bpp: 32, refreshRate: 60 };
        system.emulatedDisplayMode = null;
        expect([caps(HORZRES), caps(VERTRES), caps(BITSPIXEL)]).toEqual([1024, 768, 32]);
    });

    test("the published mode after a mode-set", () => {
        EmulatorConfig.getInstance().screenResolution = { width: 1024, height: 768, bpp: 32, refreshRate: 60 };
        system.requestHostResize(640, 480, { modeSet: true, bpp: 16 });
        expect([caps(HORZRES), caps(VERTRES), caps(BITSPIXEL)]).toEqual([640, 480, 16]);
    });

    test("a window-sized host resize is not a mode", () => {
        EmulatorConfig.getInstance().screenResolution = { width: 1024, height: 768, bpp: 32, refreshRate: 60 };
        system.requestHostResize(800, 600);
        expect([caps(HORZRES), caps(VERTRES)]).toEqual([1024, 768]);
    });
});
