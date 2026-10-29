/**
 * IFC20/IFC21/IFC22 are versions of one force-feedback class library. Each is
 * force-stubbed by the PE loader, so a version without handlers answers every
 * constructor with an unwritten object and a NULL `this`.
 */
import { describe, expect, test } from "bun:test";
import { PELoader } from "../../src/worker/core/pe-loader";
import { IFC20 } from "../../src/worker/modules/ifc20";

const THIS = 0x100;

describe("Immersion Foundation Classes 2.x", () => {
    test("every IFC DLL the loader force-stubs is served by the IFC module", () => {
        const forced = [...(PELoader as unknown as { DLL_FORCE_STUB: Set<string> }).DLL_FORCE_STUB]
            .filter(name => name.startsWith("ifc"));
        const ifc = new IFC20();
        expect(forced.length).toBeGreaterThan(0);
        for (const name of forced) expect([ifc.name, ...ifc.aliases]).toContain(name);
    });

    test("the CImmProject constructor clears the object and returns this", () => {
        const ifc = new IFC20();
        ifc.initialize({ thunkGenerator: null, getCurrentMemory: () => null } as never);
        const mem = new Uint8Array(0x200).fill(0xcc);
        const ret = ifc.exports["??0CImmProject@@QAE@XZ"]!({ ecx: THIS } as never, mem, []);
        expect(ret).toBe(THIS);
        expect([...mem.subarray(THIS, THIS + 0x10)].every(b => b === 0)).toBe(true);
        expect(mem[THIS + 0x10]).toBe(0xcc);
    });
});
