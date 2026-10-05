import { describe, expect, test } from "bun:test";
import { uxthemeModule } from "../../src/worker/api/uxtheme.api";
import { Uxtheme } from "../../src/worker/modules/uxtheme";

describe("UXTHEME capability probes", () => {
    test("exports the zero-argument probes with the stdcall ABI", () => {
        for (const name of ["IsThemeActive", "IsAppThemed"]) {
            const fn = uxthemeModule.functions.find((candidate) => candidate.name === name);
            expect(fn?.params).toHaveLength(0);
            expect(fn?.callingConvention).toBe("stdcall");
        }
    });

    test("reports visual styles disabled", () => {
        const module = new Uxtheme();
        module.initialize({} as never);
        expect(module.exports.IsThemeActive!({} as never, new Uint8Array(), [])).toBe(0);
        expect(module.exports.IsAppThemed!({} as never, new Uint8Array(), [])).toBe(0);
    });
});
