import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { BaseComObject } from "../../src/worker/core/com/base-com-object";
import { registerComVtableOwner } from "../../src/worker/core/com/com-memory";
import { describeComObject } from "../../src/worker/core/resources/system-resource-provider";
import { CaptureRefusal, newObjectGraph } from "../../src/worker/savestate/object-codecs";

const IID = "279afa86-4981-11ce-a521-0020af0be560";

class NoCodecBuffer extends BaseComObject {
    constructor(vtable: number) {
        super(IID, vtable);
    }

    protected destroy(): void {
        return;
    }
}

let before = new Set<number>();
beforeEach(() => {
    before = new Set(System.getInstance().resourceProvider.getAllComObjects().map(o => o.handle));
});
afterEach(() => {
    for (const o of System.getInstance().resourceProvider.getAllComObjects()) if (!before.has(o.handle)) o.forceRelease();
});

describe("savestate refusals name the COM interface", () => {
    test("an object without a codec is named by interface, owning module and iid, not only by its constructor", () => {
        registerComVtableOwner(0x7f001000, "dsound", "IDirectSound3DBuffer");
        const obj = new NoCodecBuffer(0x7f001000);
        const graph = newObjectGraph();
        let message = "";
        try {
            System.getInstance().resourceProvider.captureState((o, w) => graph.ref(o, w));
        } catch (e) {
            expect(e).toBeInstanceOf(CaptureRefusal);
            message = (e as Error).message;
        }
        expect(message).toBe(`com 0x${obj.handle.toString(16)} [IDirectSound3DBuffer of dsound, iid ${IID}]: no savestate codec for NoCodecBuffer`);
    });

    test("an unregistered vtable still gives its address and the iid; a non-COM entry gives what it has", () => {
        expect(describeComObject(new NoCodecBuffer(0x7f002000))).toBe(`[vtable@0x7f002000 of unknown, iid ${IID}]`);
        expect(describeComObject(new NoCodecBuffer(0))).toBe(`[iid ${IID}]`);
        expect(describeComObject({})).toBe("[iid unknown iid]");
        expect(describeComObject(null)).toBe("[iid unknown iid]");
    });
});
