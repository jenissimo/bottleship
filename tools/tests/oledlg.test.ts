import { describe, expect, test } from "bun:test";
import { oledlgModule } from "../../src/worker/api/oledlg.api";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { Oledlg } from "../../src/worker/modules/oledlg";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

describe("oledlg ordinal 1", () => {
    test("maps ordinal 1 to the nine-argument stdcall OleUIAddVerbMenuA ABI", () => {
        const fn = oledlgModule.functions.find(({ ordinal }) => ordinal === 1);
        expect(fn?.name).toBe("OleUIAddVerbMenuA");
        expect(fn?.callingConvention).toBe("stdcall");
        expect(fn?.params).toHaveLength(9);
        expect(fn?.params.map(({ name }) => name)).toEqual([
            "lpOleObj", "lpszShortType", "hMenu", "uPos", "uIDVerbMin",
            "uIDVerbMax", "bAddConvert", "idConvert", "lphMenu",
        ]);
    });

    test("resolves ordinal imports to the named implementation", () => {
        const registry = APIRegistry.getInstance();
        registry.registerModule(oledlgModule);
        expect(registry.getFunctionNameByOrdinal("oledlg.dll", 1)).toBe("OleUIAddVerbMenuA");
        expect(registry.getArgCountByOrdinal("oledlg", 1)).toBe(9);
    });

    test("safely reports no verb menu and clears lphMenu", () => {
        const module = new Oledlg();
        module.initialize({} as never);
        const mem = new Uint8Array(64);
        Mem.bind(() => mem);
        const out = 32;
        new DataView(mem.buffer).setUint32(out, 0xdeadbeef, true);

        expect(module.exports.OleUIAddVerbMenuA(null as never, mem, [0x100, 0, 0x200, 0, 0, 0, 0, 0, out])).toBe(0);
        expect(new DataView(mem.buffer).getUint32(out, true)).toBe(0);
    });
});
