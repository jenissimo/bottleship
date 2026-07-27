// Unit tests for the GetProcAddress census (src/worker/core/diagnostics).
// This is the half of a title's API surface no import table can show, so what the
// registry records about each DYNAMIC resolution — specifically whether the guest got
// a real handler, a stub, or NULL — is the whole value. Pure unit: the registry only
// needs TimeService, no v86/DOM.

import { describe, it, expect, beforeEach } from "bun:test";
import {
    getProcAddressRegistry, UNSATISFIED_RESOLUTIONS,
    type GetProcResolution,
} from "../../src/worker/core/diagnostics/get-proc-address-registry";
import { apiCensus, SILENT_STUBS } from "../../src/worker/core/diagnostics/api-census";

const rec = (proc: string, addr: number, kind: GetProcResolution, dll?: string, caller = 0x401000): void =>
    getProcAddressRegistry.record(0x77e00000, proc, addr, caller, kind, dll);

describe("GetProcAddress census", () => {
    beforeEach(() => getProcAddressRegistry.clear());

    it("keeps one entry per lookup and counts repeats", () => {
        rec("GetLongPathNameA", 0x1000, "hle", "kernel32");
        rec("GetLongPathNameA", 0x1000, "hle", "kernel32");
        const list = getProcAddressRegistry.list();
        expect(list).toHaveLength(1);
        expect(list[0].count).toBe(2);
        expect(list[0].dll).toBe("kernel32");
    });

    it("separates 'resolved to nothing usable' from 'resolved fine'", () => {
        rec("DirectDrawCreateEx", 0x2000, "hle", "ddraw");
        rec("SHGetFolderPathW", 0, "null", "shell32");
        rec("CreateCubeTexture", 0x3000, "stub", "d3d9");
        rec("GetPrivateData", 0x4000, "silent-stub", "ddraw");
        rec("BinkOpen", 0x5000, "guest", "binkw32");

        expect(getProcAddressRegistry.byKind())
            .toEqual({ hle: 1, "silent-stub": 1, stub: 1, guest: 1, null: 1 });

        // The work order is the unusable subset — NOT just the NULLs, which is the
        // whole point: a stub answers "yes, I exist" and then does nothing.
        expect(getProcAddressRegistry.unsatisfied().map((h) => h.procName).sort())
            .toEqual(["CreateCubeTexture", "GetPrivateData", "SHGetFolderPathW"]);
        expect(getProcAddressRegistry.misses().map((h) => h.procName)).toEqual(["SHGetFolderPathW"]);
    });

    it("ranks the unusable resolutions by how often the guest asked", () => {
        rec("Rare", 0, "null");
        for (let i = 0; i < 5; i++) rec("Hot", 0x10, "stub");
        expect(getProcAddressRegistry.unsatisfied().map((h) => h.procName)).toEqual(["Hot", "Rare"]);
    });

    it("upgrades a retried lookup that later succeeds", () => {
        rec("D3DXCreateEffect", 0, "null", "d3dx9");
        expect(getProcAddressRegistry.misses()).toHaveLength(1);
        rec("D3DXCreateEffect", 0x9000, "hle", "d3dx9");
        expect(getProcAddressRegistry.misses()).toHaveLength(0);
        expect(getProcAddressRegistry.list()[0]).toMatchObject({ kind: "hle", address: 0x9000, count: 2 });
    });

    it("keeps a chronological ring of individual lookups, newest last", () => {
        rec("A", 0x1, "hle");
        rec("B", 0, "null");
        const recent = getProcAddressRegistry.recent(4);
        expect(recent.map((r) => `${r.procName}:${r.kind}`)).toEqual(["A:hle", "B:null"]);
    });

    it("agrees with the shared vocabulary of unusable resolutions", () => {
        expect([...UNSATISFIED_RESOLUTIONS].sort()).toEqual(["null", "silent-stub", "stub"]);
    });
});

describe("call census silent-stub signal", () => {
    beforeEach(() => apiCensus.clear());

    it("flags an arg-ignoring handler and keeps counting it", () => {
        apiCensus.record("d3d9:IDirect3DDevice9_GetLight", 0, 0x401000);
        apiCensus.record("d3d9:IDirect3DDevice9_GetLight", 0, 0x401000);
        apiCensus.record("d3d9:IDirect3DDevice9_DrawPrimitive", 3, 0x402000);
        expect(apiCensus.suspectStubs().map((s) => s.name)).toEqual(["d3d9:IDirect3DDevice9_GetLight"]);
        expect(apiCensus.suspectStubs()[0].count).toBe(2);
        expect(apiCensus.list()).toHaveLength(2);
    });

    it("flags a curated handler even when it declares its arguments", () => {
        const curated = [...SILENT_STUBS][0];
        expect(curated).toBeDefined();
        apiCensus.record(curated, 3, 0x401000);
        expect(apiCensus.suspectStubs().map((s) => s.name)).toEqual([curated]);
    });

    it("records COM vtable slots, which are never imports", () => {
        apiCensus.record("ddraw:IDirectDrawSurface7_Blt", 3, 0x401000);
        expect(apiCensus.list().filter((c) => c.name.includes("_"))).toHaveLength(1);
    });
});
