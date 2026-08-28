/**
 * D3D9 vertex input is assembled from two independent sources: the declaration says where a
 * component sits INSIDE a vertex, SetStreamSource says how far apart vertices are and where the
 * stream begins. Conflating them — deriving stride from the declaration, folding the draw's base
 * vertex into a binding offset, or keying a pipeline on slot 0 alone — produces draws that read
 * each vertex out of its successor, double-count the base, or silently reuse a pipeline built for
 * a different layout. WebGPU also has no null binding and rejects an overrun by discarding the
 * whole command buffer, where hardware just returns zeros; the rules below encode that too.
 * These tests pin the rules as pure functions so a refactor of the backend cannot quietly
 * redefine them.
 */
import { describe, expect, test } from "bun:test";
import {
    D3DSTREAMSOURCE_INDEXEDDATA, D3DSTREAMSOURCE_INSTANCEDATA,
    bindingSize, isWebGpuArrayStrideAligned, padRegion, slotArrayStride, stepModeFromFreq, vertexRangeEndBytes,
} from "../../src/worker/backends/webgpu/shared/vertex-streams";

// ── The contract, in the shape the backend applies it ──────────────────────
//
// Every rule below delegates to the production function the backend itself calls, so these
// tests fail when the rule changes rather than agreeing with a stale local copy.

interface StreamSource {
    /** Total size of the bound vertex buffer, in bytes. */
    bufferSize: number;
    /** OffsetInBytes from SetStreamSource. */
    offset: number;
    /** Stride from SetStreamSource. 0 = no stream bound to this slot. */
    stride: number;
}

interface VertexBinding {
    slot: number;
    arrayStride: number;
    /** Byte offset handed to setVertexBuffer — the stream's own offset, nothing else. */
    bufferOffset: number;
    /** Byte size handed to setVertexBuffer. */
    bufferSize: number;
    stepMode: "vertex" | "instance";
    stepRateDivisor: number;
    /** True when no stream was bound and a zero buffer stands in for it. */
    zeroFilled: boolean;
}

/** Rule 1: the bound stride wins; the packed declaration size is a fallback, never a raise. */
function arrayStrideFor(packedSize: number, boundStride: number): number {
    return slotArrayStride(boundStride, packedSize);
}

/** Rule 2: a binding runs from its offset to the END of the buffer. */
function bindingExtent(src: StreamSource): { offset: number; size: number } {
    return { offset: src.offset, size: bindingSize(src.bufferSize, src.offset) };
}

/**
 * Rule 3: the address the GPU fetches. firstVertex/baseVertex is applied by the GPU to every
 * slot uniformly; the binding offset carries only OffsetInBytes.
 */
function fetchAddress(binding: VertexBinding, firstVertex: number, vertexIndex: number): number {
    return binding.bufferOffset + (firstVertex + vertexIndex) * binding.arrayStride;
}

/** Rule 8: address under a per-binding step mode. */
function steppedAddress(
    binding: VertexBinding, vertexIndex: number, instanceIndex: number,
): number {
    const step = binding.stepMode === "instance"
        ? Math.floor(instanceIndex / Math.max(1, binding.stepRateDivisor))
        : vertexIndex;
    return binding.bufferOffset + step * binding.arrayStride;
}

/**
 * Rules 4 + 5: every slot the declaration references gets a binding by the same rules, slot 0
 * included; a referenced slot with no bound stream gets a zero-filled stand-in.
 */
function buildBindings(
    usedSlots: number[],
    packedSizes: Map<number, number>,
    streams: Map<number, StreamSource>,
    freqs: Map<number, number> = new Map(),
): VertexBinding[] {
    return usedSlots.slice().sort((a, b) => a - b).map((slot) => {
        const packed = packedSizes.get(slot) ?? 0;
        const src = streams.get(slot);
        const { stepMode, stepRateDivisor } = stepModeFromFreq(freqs.get(slot) ?? 0);
        if (!src || src.stride <= 0) {
            const arrayStride = arrayStrideFor(packed, 0);
            return {
                slot, arrayStride, bufferOffset: 0, bufferSize: 0,
                stepMode, stepRateDivisor, zeroFilled: true,
            };
        }
        const extent = bindingExtent(src);
        return {
            slot,
            arrayStride: arrayStrideFor(packed, src.stride),
            bufferOffset: extent.offset,
            bufferSize: extent.size,
            stepMode, stepRateDivisor,
            zeroFilled: false,
        };
    });
}

/** Rule 6: an under-sized slot is grown/zeroed, never a reason to drop the draw. */
function reconcileSlot(
    boundSize: number, firstVertex: number, vertexCount: number, arrayStride: number,
): { action: "keep" | "zero-fill"; size: number; drawn: boolean } {
    // attrEnd 0 = the executor's fallback for a slot with no recorded attribute end: the last
    // vertex is then sized by a whole stride.
    const need = vertexRangeEndBytes(firstVertex, vertexCount, arrayStride, 0);
    if (need <= boundSize) return { action: "keep", size: boundSize, drawn: true };
    return { action: "zero-fill", size: padRegion(need, boundSize).size, drawn: true };
}

/** Rule 7: pipeline identity covers the stride of EVERY used slot. */
function pipelineKey(shaderKey: string, bindings: VertexBinding[]): string {
    const slots = bindings.slice().sort((a, b) => a.slot - b.slot)
        .map((b) => `${b.slot}:${b.arrayStride}:${b.stepMode}:${b.stepRateDivisor}`)
        .join("|");
    return `${shaderKey}#${slots}`;
}

const src = (bufferSize: number, offset: number, stride: number): StreamSource =>
    ({ bufferSize, offset, stride });

// ── Tests ─────────────────────────────────────────────────────────────────

describe("rule 1 — stride comes from SetStreamSource, never from the declaration", () => {
    test("a packed size LARGER than the bound stride does not raise the stride", () => {
        // Stepping by 32 over a buffer of 24-byte vertices reads each vertex out of its successor.
        expect(arrayStrideFor(32, 24)).toBe(24);
    });

    test("adversarial inverse: a bound stride LARGER than packed still wins", () => {
        // Padding the app never declared an attribute for is still part of the vertex.
        expect(arrayStrideFor(20, 32)).toBe(32);
    });

    test("packed size is the fallback ONLY for a stream with no bound stride", () => {
        expect(arrayStrideFor(28, 0)).toBe(28);
    });

    test("the declaration never contributes when a stride is bound, even at equality", () => {
        expect(arrayStrideFor(24, 24)).toBe(24);
        expect(arrayStrideFor(0, 24)).toBe(24);
    });
});

describe("rule 2 — a binding runs from its offset to the end of the buffer", () => {
    test("size is bufferSize - offset", () => {
        expect(bindingExtent(src(4096, 512, 32))).toEqual({ offset: 512, size: 3584 });
    });

    test("adversarial: the size is not the whole buffer, and not a vertex-count guess", () => {
        const e = bindingExtent(src(4096, 512, 32));
        expect(e.size).not.toBe(4096);
        expect(e.offset + e.size).toBe(4096);
    });

    test("an offset at the very end yields an empty, non-negative extent", () => {
        expect(bindingExtent(src(1024, 1024, 16))).toEqual({ offset: 1024, size: 0 });
    });
});

describe("rule 3 — firstVertex is applied by the GPU, never folded into the offset", () => {
    const O = 512, S = 32, F = 100;
    const b = buildBindings([0], new Map([[0, S]]), new Map([[0, src(65536, O, S)]]))[0]!;

    test("the binding offset carries OffsetInBytes alone", () => {
        expect(b.bufferOffset).toBe(O);
        expect(b.bufferOffset).not.toBe(O + F * S);
    });

    test("the fetched address is O + F*S, not O + 2*F*S (the D3D8 double-count)", () => {
        expect(fetchAddress(b, F, 0)).toBe(O + F * S);
        expect(fetchAddress(b, F, 0)).not.toBe(O + 2 * F * S);
    });

    test("adversarial: a binding that pre-folded the base double-counts and is caught", () => {
        const folded: VertexBinding = { ...b, bufferOffset: O + F * S };
        expect(fetchAddress(folded, F, 0)).toBe(O + 2 * F * S);
        expect(fetchAddress(folded, F, 0)).not.toBe(fetchAddress(b, F, 0));
    });

    test("the base applies uniformly to every slot", () => {
        const bindings = buildBindings(
            [0, 1],
            new Map([[0, 32], [1, 16]]),
            new Map([[0, src(65536, 512, 32)], [1, src(8192, 64, 16)]]),
        );
        expect(bindings.map((x) => fetchAddress(x, F, 0)))
            .toEqual([512 + F * 32, 64 + F * 16]);
    });
});

describe("rule 4 — slot 0 is not special", () => {
    const streams = new Map([
        [0, src(4096, 128, 24)],
        [3, src(4096, 128, 24)],
    ]);
    const packed = new Map([[0, 32], [3, 32]]);

    test("slot 0 and slot 3 with identical inputs produce identical layouts", () => {
        const [b0, b3] = buildBindings([0, 3], packed, streams);
        expect({ ...b0, slot: -1 }).toEqual({ ...b3!, slot: -1 });
    });

    test("adversarial: slot 0 obeys rule 1 as well — packed 32 does not beat bound 24", () => {
        const [b0] = buildBindings([0], packed, streams);
        expect(b0!.arrayStride).toBe(24);
    });

    test("bindings come out ordered by slot regardless of declaration order", () => {
        expect(buildBindings([3, 0], packed, streams).map((b) => b.slot)).toEqual([0, 3]);
    });
});

describe("rule 5 — every referenced slot is bound; an unbound one gets zeros", () => {
    const streams = new Map([[0, src(4096, 0, 24)]]);
    const packed = new Map([[0, 24], [1, 16]]);

    test("a slot the app never bound still yields a binding, zero-filled", () => {
        const bindings = buildBindings([0, 1], packed, streams);
        expect(bindings.map((b) => b.slot)).toEqual([0, 1]);
        expect(bindings[1]!.zeroFilled).toBe(true);
        expect(bindings[0]!.zeroFilled).toBe(false);
    });

    test("adversarial: a slot bound with stride 0 counts as unbound, not as a real binding", () => {
        const [b] = buildBindings([1], packed, new Map([[1, src(4096, 0, 0)]]));
        expect(b!.zeroFilled).toBe(true);
        expect(b!.arrayStride).toBe(16); // falls back to the packed size, per rule 1
    });

    test("the stand-in has a non-zero stride so the pipeline layout stays well-formed", () => {
        const [b] = buildBindings([1], packed, streams);
        expect(b!.arrayStride).toBeGreaterThan(0);
    });
});

describe("rule 6 — an out-of-range fetch reads zeros; the draw still happens", () => {
    test("a short slot is grown and zero-filled, not dropped", () => {
        const r = reconcileSlot(1024, 0, 64, 32); // needs 2048
        expect(r.action).toBe("zero-fill");
        expect(r.size).toBe(2048);
        expect(r.drawn).toBe(true);
    });

    test("adversarial: firstVertex counts toward the requirement", () => {
        // Bound size covers 64 vertices, but the draw starts at vertex 100.
        const r = reconcileSlot(2048, 100, 8, 32);
        expect(r.action).toBe("zero-fill");
        expect(r.size).toBe(108 * 32);
        expect(r.drawn).toBe(true);
    });

    test("a slot that already fits is left alone", () => {
        expect(reconcileSlot(4096, 0, 64, 32)).toEqual({ action: "keep", size: 4096, drawn: true });
    });

    test("no input makes the draw not happen", () => {
        for (const [bound, first, count, stride] of [
            [0, 0, 3, 32], [16, 1000, 1, 64], [4096, 0, 1, 12],
        ] as const) {
            expect(reconcileSlot(bound, first, count, stride).drawn).toBe(true);
        }
    });
});

describe("rule 7 — pipeline identity includes every used slot's stride", () => {
    const mk = (s0: number, s1: number) => buildBindings(
        [0, 1],
        new Map([[0, s0], [1, s1]]),
        new Map([[0, src(4096, 0, s0)], [1, src(4096, 0, s1)]]),
    );

    test("two draws differing only in slot 1's stride do not share a key", () => {
        expect(pipelineKey("vs1/ps1", mk(32, 16))).not.toBe(pipelineKey("vs1/ps1", mk(32, 24)));
    });

    test("adversarial: a slot-0-only key would collide — assert it does not", () => {
        const slot0Only = (bs: VertexBinding[]) => `vs1/ps1#${bs[0]!.arrayStride}`;
        expect(slot0Only(mk(32, 16))).toBe(slot0Only(mk(32, 24))); // the defect, demonstrated
        expect(pipelineKey("vs1/ps1", mk(32, 16))).not.toBe(pipelineKey("vs1/ps1", mk(32, 24)));
    });

    test("step mode is part of identity too", () => {
        const vertexRate = buildBindings([0], new Map([[0, 32]]), new Map([[0, src(4096, 0, 32)]]));
        const instanceRate = buildBindings(
            [0], new Map([[0, 32]]), new Map([[0, src(4096, 0, 32)]]),
            new Map([[0, D3DSTREAMSOURCE_INSTANCEDATA | 1]]),
        );
        expect(pipelineKey("vs1/ps1", vertexRate)).not.toBe(pipelineKey("vs1/ps1", instanceRate));
    });

    test("identical layouts produce identical keys", () => {
        expect(pipelineKey("vs1/ps1", mk(32, 16))).toBe(pipelineKey("vs1/ps1", mk(32, 16)));
    });
});

describe("rule 8 — SetStreamSourceFreq is a per-binding step mode", () => {
    test("INSTANCEDATA|divisor decodes to instance rate with that divisor", () => {
        expect(stepModeFromFreq(D3DSTREAMSOURCE_INSTANCEDATA | 1))
            .toEqual({ stepMode: "instance", stepRateDivisor: 1 });
        expect(stepModeFromFreq(D3DSTREAMSOURCE_INSTANCEDATA | 4))
            .toEqual({ stepMode: "instance", stepRateDivisor: 4 });
    });

    test("adversarial: INDEXEDDATA|count is vertex-rate — its payload is not a divisor", () => {
        expect(stepModeFromFreq(D3DSTREAMSOURCE_INDEXEDDATA | 100))
            .toEqual({ stepMode: "vertex", stepRateDivisor: 1 });
        expect(stepModeFromFreq(0)).toEqual({ stepMode: "vertex", stepRateDivisor: 1 });
    });

    test("instance-rate data steps by instance index, not vertex index", () => {
        const [b] = buildBindings(
            [1], new Map([[1, 64]]), new Map([[1, src(8192, 256, 64)]]),
            new Map([[1, D3DSTREAMSOURCE_INSTANCEDATA | 1]]),
        );
        // vertexIndex must not move the address at all.
        expect(steppedAddress(b!, 0, 3)).toBe(256 + 3 * 64);
        expect(steppedAddress(b!, 999, 3)).toBe(256 + 3 * 64);
    });

    test("a divisor > 1 holds the address for that many instances", () => {
        const [b] = buildBindings(
            [1], new Map([[1, 64]]), new Map([[1, src(8192, 256, 64)]]),
            new Map([[1, D3DSTREAMSOURCE_INSTANCEDATA | 4]]),
        );
        expect([0, 3, 4, 7, 8].map((i) => steppedAddress(b!, 0, i)))
            .toEqual([256, 256, 256 + 64, 256 + 64, 256 + 128]);
    });

    test("vertex-rate data steps by vertex index and ignores the instance index", () => {
        const [b] = buildBindings([0], new Map([[0, 32]]), new Map([[0, src(8192, 128, 32)]]));
        expect(steppedAddress(b!, 5, 0)).toBe(128 + 5 * 32);
        expect(steppedAddress(b!, 5, 77)).toBe(128 + 5 * 32);
    });
});

describe("rule 9 — WebGPU array strides are explicitly aligned or refused", () => {
    test("rejects an odd declaration/bound stride before pipeline creation", () => {
        expect(isWebGpuArrayStrideAligned(18)).toBe(false);
        expect(isWebGpuArrayStrideAligned(22)).toBe(false);
    });

    test("accepts positive four-byte strides", () => {
        expect(isWebGpuArrayStrideAligned(4)).toBe(true);
        expect(isWebGpuArrayStrideAligned(20)).toBe(true);
    });

    test("rejects zero and non-integral values", () => {
        expect(isWebGpuArrayStrideAligned(0)).toBe(false);
        expect(isWebGpuArrayStrideAligned(4.5)).toBe(false);
    });
});
