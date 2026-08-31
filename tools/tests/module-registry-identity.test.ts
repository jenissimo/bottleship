/**
 * A module is the FILE it maps, so the registry key is the basename WITH its extension.
 *
 * Both halves are load-bearing and pull in opposite directions:
 *  - basename, so `c:\system\engine.dll` (LoadLibrary) and `engine.dll` (import table) are
 *    ONE module. Two copies of an image have separate statics — Hitman's gsc.dll
 *    registered its script host under "c:\gsc" and hitmandlc.dlc read back NULL.
 *  - extension, so XIII.exe and Xiii.dll are TWO. With it stripped the EXE owned the key,
 *    every import of Xiii.dll bound to the missing-import trap stub, and the game died in
 *    xidpawn.dll's static constructors.
 *
 * A name with no extension means ".dll" — the LoadLibrary/GetModuleHandle rule findDllPath
 * already applies to the VFS lookup.
 */

import { expect, test } from "bun:test";
import { ModuleRegistry, type LoadedPEModule } from "../../src/worker/core/module-registry";

const mod = (name: string, baseAddress: number, isExecutable = false): LoadedPEModule => ({
    name,
    path: `C:\\system\\${name}`,
    baseAddress,
    size: 0x1000,
    entryPoint: 0,
    exports: new Map(),
    ordinalExports: new Map(),
    isRealDll: !isExecutable,
    isExecutable,
    initialized: true,
});

const EXE_BASE = 0x10900000;
const DLL_BASE = 0x11b00000;

test("an EXE and a DLL of the same basename are two modules", () => {
    const r = new ModuleRegistry();
    r.register(mod("xiii.exe", EXE_BASE, true));
    r.register(mod("xiii.dll", DLL_BASE));

    expect(r.getByName("xiii.exe")?.baseAddress).toBe(EXE_BASE);
    expect(r.getByName("XIII.dll")?.baseAddress).toBe(DLL_BASE);
    // The import table spells it without the extension; Win32 reads that as ".dll".
    expect(r.getByName("xiii")?.baseAddress).toBe(DLL_BASE);
    // Registering the DLL must not have evicted the EXE.
    expect(r.getExecutableModule()?.baseAddress).toBe(EXE_BASE);
});

test("a full path and a bare import name are the same module", () => {
    const r = new ModuleRegistry();
    r.register(mod("engine.dll", 0x10300000));

    for (const spelling of ["engine", "engine.dll", "c:\\system\\engine.dll", "C:/system/Engine.DLL"]) {
        expect(r.getByName(spelling)?.baseAddress).toBe(0x10300000);
    }
});

test("a non-.dll extension is kept, not treated as a name to extend", () => {
    const r = new ModuleRegistry();
    r.register(mod("binkw32.drv", 0x12000000));

    expect(r.getByName("binkw32.drv")?.baseAddress).toBe(0x12000000);
    // "binkw32" means binkw32.dll, which is not loaded.
    expect(r.getByName("binkw32")).toBeUndefined();
});

test("unregister keys the same way, so FreeLibrary cannot drop the EXE", () => {
    const r = new ModuleRegistry();
    r.register(mod("xiii.exe", EXE_BASE, true));
    r.register(mod("xiii.dll", DLL_BASE));

    expect(r.unregister("c:\\system\\xiii.dll")).toBe(true);
    expect(r.getByName("xiii")).toBeUndefined();
    expect(r.getExecutableModule()?.baseAddress).toBe(EXE_BASE);
});
