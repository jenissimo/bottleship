/**
 * D3D9 hardware instancing is two dividers that mean different things. SetStreamSourceFreq
 * writes D3DSTREAMSOURCE_INDEXEDDATA|N on the geometry stream — where N is the draw's INSTANCE
 * COUNT, not a rate — and D3DSTREAMSOURCE_INSTANCEDATA|D on the per-instance stream, where D
 * really is a rate. Read either one as the other and the draw still renders: the count becomes a
 * silent stride divisor, or every instance is drawn from instance 0's data. Advertising vs_3_0
 * IS the claim that this works, so the rules are pinned here as pure functions the backend calls.
 */
import { describe, expect, test } from "bun:test";
import {
    D3DSTREAMSOURCE_INDEXEDDATA, D3DSTREAMSOURCE_INSTANCEDATA, MAX_VERTEX_STREAMS,
    applyStepModes, expandInstanceRateData, planInstancing,
} from "../../src/worker/backends/webgpu/shared/vertex-streams";

/** Dividers per slot, defaulting every unnamed slot to 1 (what the device's table holds). */
function freqs(set: Record<number, number>): Uint32Array {
    const f = new Uint32Array(MAX_VERTEX_STREAMS).fill(1);
    for (const [slot, value] of Object.entries(set)) f[Number(slot)] = value >>> 0;
    return f;
}

/** The CryEngine vegetation shape: geometry on slot 0, per-instance transforms on slot 1. */
const INSTANCED_PAIR = freqs({
    0: D3DSTREAMSOURCE_INDEXEDDATA | 64,
    1: D3DSTREAMSOURCE_INSTANCEDATA | 1,
});

describe("planInstancing — what the dividers ask the draw for", () => {
    test("an untouched device draws one instance and is not instanced", () => {
        expect(planInstancing(freqs({}), 0b11)).toEqual({ instanceCount: 1, instanced: false, refuse: null });
    });

    test("INDEXEDDATA|N is the instance count", () => {
        expect(planInstancing(INSTANCED_PAIR, 0b11))
            .toEqual({ instanceCount: 64, instanced: true, refuse: null });
    });

    test("adversarial: the count must not be read off the INSTANCEDATA stream", () => {
        // Reading slot 1's divider as the count would draw 1 instance and lose 63 of them.
        expect(planInstancing(INSTANCED_PAIR, 0b11).instanceCount).toBe(64);
    });

    test("a divisor above 1 is lowered by repeated instance records", () => {
        const plan = planInstancing(freqs({
            0: D3DSTREAMSOURCE_INDEXEDDATA | 8,
            1: D3DSTREAMSOURCE_INSTANCEDATA | 4,
        }), 0b11);
        expect(plan).toEqual({ instanceCount: 8, instanced: true, refuse: null });
    });

    test("instance-rate data with no count to pair against is refused, not guessed", () => {
        expect(planInstancing(freqs({ 1: D3DSTREAMSOURCE_INSTANCEDATA | 1 }), 0b11).refuse)
            .toBe("instancingNoIndexedStream");
    });

    test("a divider left on a slot this draw does not read is not this draw's instancing", () => {
        expect(planInstancing(INSTANCED_PAIR, 0b100))
            .toEqual({ instanceCount: 1, instanced: false, refuse: null });
    });

    test("an instance count of zero is the guest's own, and stays zero", () => {
        expect(planInstancing(freqs({ 0: D3DSTREAMSOURCE_INDEXEDDATA | 0, 1: D3DSTREAMSOURCE_INSTANCEDATA | 1 }), 0b11))
            .toEqual({ instanceCount: 0, instanced: true, refuse: null });
    });
});

describe("expandInstanceRateData — WebGPU divisor lowering", () => {
    test("repeats each source record for the requested rate", () => {
        const source = new Uint8Array([10, 11, 20, 21, 30, 31]);
        expect(expandInstanceRateData(source, 0, 2, 6, 2)).toEqual(new Uint8Array([
            10, 11, 10, 11, 20, 21, 20, 21, 30, 31, 30, 31,
        ]));
    });

    test("keeps the guest stream offset and zero-fills missing records", () => {
        const source = new Uint8Array([99, 10, 11, 20]);
        expect(expandInstanceRateData(source, 1, 2, 4, 2)).toEqual(new Uint8Array([
            10, 11, 10, 11, 20, 0, 20, 0,
        ]));
    });

    test("bounds corrupt instance allocations", () => {
        expect(expandInstanceRateData(new Uint8Array([1]), 0, 64, 2_000_000, 1)).toBeNull();
    });

    test("reuses the expansion scratch after the caller consumes the previous upload", () => {
        const first = expandInstanceRateData(new Uint8Array([1, 2]), 0, 2, 1, 1)!;
        const firstBuffer = first.buffer;
        const second = expandInstanceRateData(new Uint8Array([3, 4]), 0, 2, 1, 1)!;
        expect(second.buffer).toBe(firstBuffer);
        expect(second).toEqual(new Uint8Array([3, 4]));
    });
});

describe("applyStepModes — the layout half of the same rule", () => {
    const layouts = (): (GPUVertexBufferLayout | null)[] => [
        { arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
        { arrayStride: 64, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x4" }] },
    ];

    test("the INSTANCEDATA slot steps per instance, the INDEXEDDATA slot per vertex", () => {
        const out = applyStepModes(layouts(), INSTANCED_PAIR);
        expect(out[0]!.stepMode).toBeUndefined();      // vertex rate = WebGPU's default
        expect(out[1]!.stepMode).toBe("instance");
    });

    test("adversarial: the count stream must NOT become instance-rate", () => {
        // If it did, every vertex of the mesh would be read as another instance's data and the
        // geometry would collapse — a frame that still renders, which is why this is pinned.
        expect(applyStepModes(layouts(), INSTANCED_PAIR)[0]!.stepMode).not.toBe("instance");
    });

    test("strides and attributes survive the pass untouched", () => {
        const out = applyStepModes(layouts(), INSTANCED_PAIR);
        expect(out.map(l => l!.arrayStride)).toEqual([32, 64]);
        expect(out[1]!.attributes).toEqual(layouts()[1]!.attributes);
    });

    test("holes stay holes, and no dividers means no change", () => {
        const withHole: (GPUVertexBufferLayout | null)[] = [layouts()[0]!, null, layouts()[1]!];
        expect(applyStepModes(withHole, freqs({ 2: D3DSTREAMSOURCE_INSTANCEDATA | 1 }))[1]).toBeNull();
        const same = layouts();
        expect(applyStepModes(same, null)).toBe(same);
    });
});
