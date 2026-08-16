import { afterEach, describe, expect, test } from "bun:test";
import { oleaut32Module } from "../../src/worker/api/oleaut32.api";
import { System } from "../../src/worker/core/system";
import { Oleaut32 } from "../../src/worker/modules/oleaut32";

const mem = new Uint8Array(0x10000);
const view = new DataView(mem.buffer);
const system = System.getInstance();
const priorProcess = system.process;

afterEach(() => {
    system.process = priorProcess;
});

function createOleaut32ForBstrTests(): Oleaut32 {
    let next = 0x3000;
    system.process = {
        memory: {
            alloc: (size: number) => {
                const result = next;
                next += size;
                return result;
            },
            free: () => {},
        },
    } as any;

    const oleaut = new Oleaut32();
    // This test only exercises the BSTR exports; typelib vtables need a full Process.
    (oleaut as any).typeLibRuntime.initialize = () => {};
    oleaut.initialize({} as any);
    return oleaut;
}

describe("OLEAUT32 ordinal 150", () => {
    test("describes the SysAllocStringByteLen ABI", () => {
        const ordinal = oleaut32Module.functions.find(fn => fn.name === "ord_150");
        expect(ordinal?.ordinal).toBe(150);
        expect(ordinal?.params.length).toBe(2);
        expect(oleaut32Module.functions.some(fn => fn.name === "SysAllocStringByteLen")).toBe(true);
    });

    test("allocates a byte-counted BSTR and aliases the named export", () => {
        const oleaut = createOleaut32ForBstrTests();
        mem.set([0x41, 0x00, 0x42, 0xff], 0x1000);

        expect(oleaut.exports["ord_150"]).toBe(oleaut.exports["SysAllocStringByteLen"]);
        const bstr = oleaut.exports["ord_150"]!({} as any, mem, [0x1000, 4]) as number;

        expect(bstr).toBe(0x3004);
        expect(view.getUint32(bstr - 4, true)).toBe(4);
        expect(Array.from(mem.subarray(bstr, bstr + 4))).toEqual([0x41, 0x00, 0x42, 0xff]);
        expect(view.getUint16(bstr + 4, true)).toBe(0);
    });

    test("supports a null source without reading guest memory", () => {
        const oleaut = createOleaut32ForBstrTests();
        const bstr = oleaut.exports["SysAllocStringByteLen"]!({} as any, mem, [0, 3]) as number;

        expect(view.getUint32(bstr - 4, true)).toBe(3);
        expect(view.getUint16(bstr + 3, true)).toBe(0);
    });
});
