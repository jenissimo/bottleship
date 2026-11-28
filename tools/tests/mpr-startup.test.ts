import { expect, test } from "bun:test";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { MEM_HLE_IMAGE_BASE, MEM_HLE_IMAGE_SIZE } from "../../src/worker/core/cpu/emulator-config";
import { materializeHleModuleImages, resetHleModuleImages } from "../../src/worker/core/hle-module-images";
import { isVirtualHleSystemFile } from "../../src/worker/core/hle-system-catalog";
import { resetGuestCodeInvalidationState } from "../../src/worker/core/memory/guest-code";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { unimplementedReturnValue } from "../../src/worker/core/thunking/unimplemented-return";
import { exports as kernel32 } from "../../src/worker/modules/kernel32/module/module";
import { preserveMemBinding } from "./helpers/scoped-process-state";

preserveMemBinding();

test("mpr.dll loads and resolves WNet startup probes without a guest DLL", async () => {
    const system = System.getInstance();
    const previousProcess = system.process;
    const mem = new Uint8Array(MEM_HLE_IMAGE_BASE + MEM_HLE_IMAGE_SIZE);
    const thunkGenerator = new ThunkGenerator();
    const process = { thunkGenerator, dispatcher: { thunkGenerator, pendingRegistrations: new Map() } };
    const registry = APIRegistry.getInstance();
    const encoder = new TextEncoder();
    const view = new DataView(mem.buffer);
    const context = { esp: 0x2000, eip: 0 } as never;
    try {
        system.process = process as never;
        Mem.bind(() => mem);
        materializeHleModuleImages(process);
        expect(isVirtualHleSystemFile("C:\\WINDOWS\\SYSTEM\\MPR.DLL")).toBe(true);

        mem.set(encoder.encode("MPR.DLL\0"), 0x1000);
        const loaded = await kernel32.LoadLibraryA!(context, mem, [0x1000]);
        expect(loaded).toHaveProperty("value");
        const handle = (loaded as { value: number }).value;
        expect(handle).toBeGreaterThan(0);
        expect(view.getUint16(handle, true)).toBe(0x5a4d);

        const probes = [
            ["WNetGetConnection", 3, 2250],
            ["WNetGetUniversalName", 4, 2250],
            ["WNetAddConnection", 3, 1222],
            ["WNetAddConnection2", 4, 1222],
            ["WNetCancelConnection", 2, 2250],
            ["WNetCancelConnection2", 3, 2250],
            ["WNetOpenEnum", 5, 1222],
            ["WNetEnumResource", 4, 6],
        ] as const;
        const exports = probes.flatMap(([name, argc, status]) => [
            [name + "A", argc, status] as const,
            [name + "W", argc, status] as const,
        ]);
        for (const [index, [name, argc, status]] of [...exports, ["WNetCloseEnum", 1, 1222] as const].entries()) {
            const namePtr = 0x11000 + index * 64;
            mem.set(encoder.encode(name + "\0"), namePtr);
            const resolved = await kernel32.GetProcAddress!(context, mem, [handle, namePtr]);
            const address = typeof resolved === "number" ? resolved : (resolved as { value: number }).value;
            const stub = thunkGenerator.findStubsByName("mpr", name).find(candidate => candidate.address === address);
            expect(stub?.stackCleanupBytes).toBe(argc * 4);
            expect([...mem.subarray(address + 11, address + 14)]).toEqual([0xc2, argc * 4, 0]);
            expect(unimplementedReturnValue(registry.getUnimplementedReturnClass("mpr", name)!)).toBe(status);
        }
    } finally {
        system.process = previousProcess;
        resetGuestCodeInvalidationState();
        resetHleModuleImages();
    }
});
