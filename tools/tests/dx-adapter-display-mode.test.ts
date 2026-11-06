/**
 * IDirect3D9::GetAdapterDisplayMode / IDirect3D8::GetAdapterDisplayMode report the
 * adapter's CURRENT display mode (MS docs; Wine answers from the output's current mode).
 * After a fullscreen device or ChangeDisplaySettings has mode-set the display they must
 * agree with SM_CXSCREEN, EnumDisplaySettings(ENUM_CURRENT_SETTINGS) and
 * GetDeviceCaps(HORZRES) — all of which follow System.emulatedDisplayMode — instead of
 * repeating the manifest's boot desktop.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createFactoryExports as createD3D9FactoryExports } from "../../src/worker/modules/d3d9/factory";
import { createFactoryExports as createD3D8FactoryExports } from "../../src/worker/modules/d3d8/factory";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";

const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_R5G6B5 = 23;
const HORZRES = 8;
const VERTRES = 10;
const P_MODE = 0x100;

const mem = new Uint8Array(0x1000);
const d3d9 = createD3D9FactoryExports();
const d3d8 = createD3D8FactoryExports();
const gdi32 = createPaintingExports();

/** D3DDISPLAYMODE { UINT Width, Height, RefreshRate; D3DFORMAT Format; } — same layout in d3d8/d3d9. */
function readMode(): [number, number, number, number] {
    return [Mem.readUint32(P_MODE)!, Mem.readUint32(P_MODE + 4)!, Mem.readUint32(P_MODE + 8)!, Mem.readUint32(P_MODE + 12)!];
}
function adapterMode9(): [number, number, number, number] {
    mem.fill(0xcc, P_MODE, P_MODE + 16);
    expect(d3d9.IDirect3D9_GetAdapterDisplayMode!({} as never, mem, [0x5000, 0, P_MODE] as never)).toBe(0);
    return readMode();
}
function adapterMode8(): [number, number, number, number] {
    mem.fill(0xcc, P_MODE, P_MODE + 16);
    expect(d3d8.IDirect3D8_GetAdapterDisplayMode!({} as never, mem, [0x5000, 0, P_MODE] as never)).toBe(0);
    return readMode();
}
const screenCaps = (): [number, number] => [
    gdi32.GetDeviceCaps!({} as never, mem, [0x20000, HORZRES] as never) as number,
    gdi32.GetDeviceCaps!({} as never, mem, [0x20000, VERTRES] as never) as number,
];

describe("adapter display mode follows the current display mode", () => {
    const system = System.getInstance();
    beforeEach(() => {
        Mem.bind(() => mem, (address, size) => address >= 0 && address + size <= mem.length);
        EmulatorConfig.getInstance().screenResolution = { width: 1024, height: 768, bpp: 32, refreshRate: 60 };
        system.emulatedDisplayMode = null;
    });
    afterEach(() => { system.emulatedDisplayMode = null; });

    test("the manifest desktop until a mode is set", () => {
        expect(adapterMode9()).toEqual([1024, 768, 60, D3DFMT_X8R8G8B8]);
        expect(adapterMode8()).toEqual([1024, 768, 60, D3DFMT_X8R8G8B8]);
    });

    test("the published mode after a mode-set, in agreement with HORZRES/VERTRES", () => {
        system.requestHostResize(800, 600, { modeSet: true, bpp: 16, refreshRate: 75 });
        expect(adapterMode9()).toEqual([800, 600, 75, D3DFMT_R5G6B5]);
        expect(adapterMode8()).toEqual([800, 600, 75, D3DFMT_R5G6B5]);
        expect(screenCaps()).toEqual([800, 600]);
    });

    test("a window-sized host resize is not a mode", () => {
        system.requestHostResize(640, 480);
        expect(adapterMode9().slice(0, 2)).toEqual([1024, 768]);
        expect(adapterMode8().slice(0, 2)).toEqual([1024, 768]);
    });

    test("only the default adapter answers", () => {
        expect(d3d9.IDirect3D9_GetAdapterDisplayMode!({} as never, mem, [0x5000, 1, P_MODE] as never)).not.toBe(0);
    });
});
