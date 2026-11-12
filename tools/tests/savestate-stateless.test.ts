import { describe, expect, test } from "bun:test";
import { STATELESS_MODULES } from "../../src/worker/savestate/stateless-modules";
import { registerCoreParticipants } from "../../src/worker/savestate/core-participants";
import { newObjectGraph } from "../../src/worker/savestate/object-codecs";

const HOST_FIELDS = new Set(["name", "exports", "process"]);

const MODULES: Record<string, () => Promise<object>> = {
    shlwapi: async () => new (await import("../../src/worker/modules/shlwapi")).Shlwapi(),
    shfolder: async () => new (await import("../../src/worker/modules/shfolder")).Shfolder(),
    psapi: async () => new (await import("../../src/worker/modules/psapi")).Psapi(),
    uxtheme: async () => new (await import("../../src/worker/modules/uxtheme")).Uxtheme(),
    dwmapi: async () => new (await import("../../src/worker/modules/dwmapi")).Dwmapi(),
    shcore: async () => new (await import("../../src/worker/modules/shcore")).Shcore(),
    msimg32: async () => new (await import("../../src/worker/modules/msimg32")).Msimg32(),
    wintrust: async () => new (await import("../../src/worker/modules/wintrust")).Wintrust(),
    crypt32: async () => new (await import("../../src/worker/modules/crypt32")).Crypt32(),
    winspool: async () => new (await import("../../src/worker/modules/winspool")).Winspool(),
    hid: async () => new (await import("../../src/worker/modules/hid")).Hid(),
    oledlg: async () => new (await import("../../src/worker/modules/oledlg")).Oledlg(),
    shell32: async () => new (await import("../../src/worker/modules/shell32")).Shell32(),
    advapi32: async () => new (await import("../../src/worker/modules/advapi32")).Advapi32(),
};

describe("stateless modules", () => {
    test("every declared module has an instance check here", () => {
        expect(Object.keys(MODULES).sort()).toEqual(Object.keys(STATELESS_MODULES).sort());
    });

    test("a declared module object holds nothing but its name, exports and process", async () => {
        for (const [name, make] of Object.entries(MODULES)) {
            const extra = Object.keys(await make()).filter(k => !HOST_FIELDS.has(k));
            expect({ name, extra }).toEqual({ name, extra: [] });
        }
    });

    test("an open handle of a handle-backed module is refused by name", () => {
        registerCoreParticipants();
        const graph = newObjectGraph();
        expect(() => graph.ref({ kind: "reg", key: "HKLM\\Software" }, "kernel 0x1004")).toThrow(/kernel 0x1004: no savestate codec for Object \(reg\)/);
        expect(() => graph.ref({ kind: "crypt_prov" }, "kernel 0x1008")).toThrow(/no savestate codec for Object \(crypt_prov\)/);
    });
});
