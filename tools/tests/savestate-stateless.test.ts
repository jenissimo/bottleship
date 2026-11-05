import { describe, expect, test } from "bun:test";
import { STATELESS_MODULES } from "../../src/worker/savestate/stateless-modules";

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
});
