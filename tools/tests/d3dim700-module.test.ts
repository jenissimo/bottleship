import { describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { d3dim700Module, D3DIM700_EXPORTS } from "../../src/worker/api/d3dim700.api";
import { D3dim700 } from "../../src/worker/modules/d3dim700";

describe("d3dim700", () => {
    test("declares every export the runtime library publishes, each with a handler", () => {
        expect(d3dim700Module.functions.map((f) => f.name)).toEqual([...D3DIM700_EXPORTS]);
        const module = new D3dim700();
        module.initialize(null as any);
        for (const name of D3DIM700_EXPORTS) expect(typeof module.exports[name]).toBe("function");
    });

    test("calling a private entry point stops the process with its name", () => {
        const system = System.getInstance() as any;
        const original = system.reportGuestCrash;
        const crashes: any[] = [];
        system.reportGuestCrash = (opts: any) => crashes.push(opts);
        try {
            const module = new D3dim700();
            module.initialize(null as any);
            module.exports["D3DMalloc"]!({ eip: 0x401000 } as any, new Uint8Array(0), []);
        } finally {
            system.reportGuestCrash = original;
        }
        expect(crashes).toHaveLength(1);
        expect(crashes[0].reason).toContain("d3dim700!D3DMalloc");
        expect(crashes[0].eip).toBe(0x401000);
    });
});
