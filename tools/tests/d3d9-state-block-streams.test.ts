/**
 * A state block that does not carry the vertex-stream bindings restores everything about a
 * draw except WHERE ITS GEOMETRY COMES FROM: Apply leaves whatever buffers happen to be bound,
 * so the object draws with another object's vertices. Nothing errors and nothing is dropped.
 *
 * The rules pinned here are D3D9's, not ours:
 *  - "Saving All Device States with a StateBlock (Direct3D 9)" — D3DSBT_ALL captures, per vertex
 *    stream, "a pointer to the vertex buffer, each argument from IDirect3DDevice9::SetStreamSource
 *    ..." and "A pointer to the index buffer".
 *  - "Saving Vertex States With a StateBlock (Direct3D 9)" — D3DSBT_VERTEXSTATE's list has the
 *    SetStreamSourceFreq DIVIDERS and the vertex declaration, but no stream binding and no index
 *    buffer. Over-capturing there would make Apply clobber bindings the app expects to survive.
 */
import { describe, expect, test } from "bun:test";
import {
    D3DSBT_ALL,
    D3DSBT_PIXELSTATE,
    D3DSBT_VERTEXSTATE,
    D3D9StateBlockRecorder,
    applyStreamStateEntry,
    captureStreamBindingEntries,
    classifyStateBlockCoverage,
    refreshStreamStateEntry,
    releaseStateBlockRefs,
    retainStateBlockRefs,
    stateBlockCapturesStreamBindings,
    type D3D9StateBlockData,
    type StateBlockEntry,
    type StreamStateDevice,
    type StreamStateEntry,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-state-block";
import { MAX_VERTEX_STREAMS } from "../../src/worker/backends/webgpu/shared/vertex-streams";
import { getComRefCount, trackComObject } from "../../src/worker/modules/d3d9/com-refs";

/** The device surface the capture/replay uses, over the same flat per-slot shape as
 *  StreamBindingTable. */
class FakeStreamDevice implements StreamStateDevice {
    readonly ptr = new Uint32Array(MAX_VERTEX_STREAMS);
    readonly offset = new Uint32Array(MAX_VERTEX_STREAMS);
    readonly stride = new Uint32Array(MAX_VERTEX_STREAMS);
    ibPtr = 0;

    getStreamBinding(slot: number): { ptr: number; offset: number; stride: number } | null {
        if (slot >= MAX_VERTEX_STREAMS) return null;
        return { ptr: this.ptr[slot]!, offset: this.offset[slot]!, stride: this.stride[slot]! };
    }

    setStreamSource(slot: number, vbPtr: number, offset: number, stride: number): number {
        this.ptr[slot] = vbPtr;
        this.offset[slot] = offset;
        this.stride[slot] = stride;
        return 0;
    }

    getBoundIndexBufferPtr(): number {
        return this.ibPtr;
    }

    setIndices(ibPtr: number): number {
        this.ibPtr = ibPtr;
        return 0;
    }
}

const applyAll = (device: StreamStateDevice, entries: StateBlockEntry[]): void => {
    for (const e of entries) {
        if (e.op === "streamSource" || e.op === "indices") applyStreamStateEntry(device, e);
    }
};

const streamEntry = (entries: StateBlockEntry[], slot: number): Extract<StateBlockEntry, { op: "streamSource" }> =>
    entries.find(e => e.op === "streamSource" && e.stream === slot) as Extract<StateBlockEntry, { op: "streamSource" }>;

describe("state block: which block type owns the stream bindings", () => {
    test("D3DSBT_ALL captures them; VERTEXSTATE and PIXELSTATE do not", () => {
        expect(stateBlockCapturesStreamBindings(D3DSBT_ALL)).toBe(true);
        // The divider is vertex state; the binding it divides is not.
        expect(stateBlockCapturesStreamBindings(D3DSBT_VERTEXSTATE)).toBe(false);
        expect(stateBlockCapturesStreamBindings(D3DSBT_PIXELSTATE)).toBe(false);
    });

    test("a recorded Begin/End block captures no type-driven set at all", () => {
        // A recorded block holds exactly the Set* calls made between Begin and End (blockType 0);
        // nothing is captured by type, so the type-driven stream sweep must not fire for it.
        expect(stateBlockCapturesStreamBindings(0)).toBe(false);
    });
});

describe("state block: capturing stream bindings", () => {
    test("captures every slot including 0, plus the index buffer", () => {
        const device = new FakeStreamDevice();
        device.setStreamSource(0, 0x1000, 16, 32);
        device.setStreamSource(3, 0x2000, 0, 12);
        device.setIndices(0x3000);

        const entries: StateBlockEntry[] = [];
        captureStreamBindingEntries(device, entries);

        expect(entries.filter(e => e.op === "streamSource")).toHaveLength(MAX_VERTEX_STREAMS);
        expect(streamEntry(entries, 0)).toEqual({ op: "streamSource", stream: 0, vbPtr: 0x1000, offset: 16, stride: 32 });
        expect(streamEntry(entries, 3)).toEqual({ op: "streamSource", stream: 3, vbPtr: 0x2000, offset: 0, stride: 12 });
        expect(entries.filter(e => e.op === "indices")).toEqual([{ op: "indices", ibPtr: 0x3000 }]);
    });

    test("a slot nothing is bound to is captured as unbound, not omitted", () => {
        // Omitting it is what makes Apply unable to UNBIND: the entry list is the whole
        // instruction set Apply has.
        const device = new FakeStreamDevice();
        const entries: StateBlockEntry[] = [];
        captureStreamBindingEntries(device, entries);
        expect(streamEntry(entries, 7)).toEqual({ op: "streamSource", stream: 7, vbPtr: 0, offset: 0, stride: 0 });
    });
});

describe("state block: applying stream bindings", () => {
    test("restores every slot, slot 0 included", () => {
        const device = new FakeStreamDevice();
        device.setStreamSource(0, 0x1000, 16, 32);
        device.setStreamSource(1, 0x2000, 4, 24);
        device.setIndices(0x3000);
        const entries: StateBlockEntry[] = [];
        captureStreamBindingEntries(device, entries);

        device.setStreamSource(0, 0x9000, 0, 8);
        device.setStreamSource(1, 0x9100, 0, 8);
        device.setIndices(0x9200);
        applyAll(device, entries);

        expect(device.getStreamBinding(0)).toEqual({ ptr: 0x1000, offset: 16, stride: 32 });
        expect(device.getStreamBinding(1)).toEqual({ ptr: 0x2000, offset: 4, stride: 24 });
        expect(device.getBoundIndexBufferPtr()).toBe(0x3000);
    });

    test("a slot bound AFTER the capture is restored to the captured value", () => {
        const device = new FakeStreamDevice();
        device.setStreamSource(2, 0x1000, 0, 20);
        const entries: StateBlockEntry[] = [];
        captureStreamBindingEntries(device, entries);

        device.setStreamSource(2, 0x4444, 64, 44);
        applyAll(device, entries);
        expect(device.getStreamBinding(2)).toEqual({ ptr: 0x1000, offset: 0, stride: 20 });
    });

    test("a slot UNBOUND at capture is restored to unbound, not left as it is", () => {
        // The silent-wrong-geometry case: slot 1 carried nothing when the block was captured,
        // the app bound instancing data to it later, and Apply must take it away again.
        const device = new FakeStreamDevice();
        device.setStreamSource(0, 0x1000, 0, 32);
        const entries: StateBlockEntry[] = [];
        captureStreamBindingEntries(device, entries);

        device.setStreamSource(1, 0x5555, 8, 16);
        device.setIndices(0x6666);
        applyAll(device, entries);

        expect(device.getStreamBinding(1)).toEqual({ ptr: 0, offset: 0, stride: 0 });
        expect(device.getBoundIndexBufferPtr()).toBe(0);
    });

    test("captured values are a snapshot — later device changes do not leak into the entries", () => {
        const device = new FakeStreamDevice();
        device.setStreamSource(0, 0x1000, 0, 32);
        const entries: StateBlockEntry[] = [];
        captureStreamBindingEntries(device, entries);
        device.setStreamSource(0, 0x7777, 12, 40);
        expect(streamEntry(entries, 0).vbPtr).toBe(0x1000);
    });
});

describe("state block: Capture refreshes a stream entry in place", () => {
    test("re-reads the live binding without replacing the entry object", () => {
        const device = new FakeStreamDevice();
        device.setStreamSource(0, 0x1000, 0, 32);
        device.setIndices(0x3000);
        const entries: StateBlockEntry[] = [];
        captureStreamBindingEntries(device, entries);
        const before = streamEntry(entries, 0);

        device.setStreamSource(0, 0x8000, 48, 28);
        device.setIndices(0x8800);
        for (const e of entries) {
            if (e.op === "streamSource" || e.op === "indices") refreshStreamStateEntry(device, e);
        }

        expect(streamEntry(entries, 0)).toBe(before); // same object, mutated
        expect(before).toEqual({ op: "streamSource", stream: 0, vbPtr: 0x8000, offset: 48, stride: 28 });
        expect(entries.find(e => e.op === "indices")).toEqual({ op: "indices", ibPtr: 0x8800 });
    });
});

describe("state block: stream entries and the rest of the machinery", () => {
    test("the recorder keys stream entries per slot, and the index buffer once", () => {
        const recorder = new D3D9StateBlockRecorder();
        recorder.begin();
        recorder.record({ op: "streamSource", stream: 0, vbPtr: 0x10, offset: 0, stride: 4 });
        recorder.record({ op: "streamSource", stream: 1, vbPtr: 0x20, offset: 0, stride: 8 });
        recorder.record({ op: "streamSource", stream: 0, vbPtr: 0x30, offset: 0, stride: 12 });
        recorder.record({ op: "indices", ibPtr: 0x40 });
        recorder.record({ op: "indices", ibPtr: 0x50 });
        const entries = recorder.end();

        expect(entries).toHaveLength(3);
        expect(streamEntry(entries, 0).vbPtr).toBe(0x30);
        expect(streamEntry(entries, 1).vbPtr).toBe(0x20);
        expect(entries.find(e => e.op === "indices")).toEqual({ op: "indices", ibPtr: 0x50 });
    });

    test("a block carrying stream entries stays off the WASM arena path", () => {
        // The arena mirror has no per-slot stream state to diff against; a slot it cannot
        // represent must downgrade the whole block to the JS replay, not be dropped.
        const streams: StateBlockEntry[] = [
            { op: "renderState", state: 7, value: 1 },
            { op: "streamSource", stream: 1, vbPtr: 0x10, offset: 0, stride: 4 },
        ];
        expect(classifyStateBlockCoverage(streams).coverable).toBe(false);
        expect(classifyStateBlockCoverage([{ op: "indices", ibPtr: 0x10 }]).coverable).toBe(false);
        expect(classifyStateBlockCoverage([{ op: "renderState", state: 7, value: 1 }]).coverable).toBe(true);
    });

    test("a captured vertex/index buffer is referenced for the block's life and released once", () => {
        // Same contract the texture/shader/declaration entries already have: the block owns a
        // reference, so the buffer cannot die under an Apply that is still going to rebind it.
        const vb = 0x5b10_0000;
        const ib = 0x5b10_1000;
        trackComObject(vb);
        trackComObject(ib);
        const data: D3D9StateBlockData = {
            devicePtr: 0,
            blockType: D3DSBT_ALL,
            entries: [
                { op: "streamSource", stream: 0, vbPtr: vb, offset: 0, stride: 16 },
                { op: "streamSource", stream: 1, vbPtr: 0, offset: 0, stride: 0 },
                { op: "indices", ibPtr: ib },
            ],
        };

        retainStateBlockRefs(data);
        expect(getComRefCount(vb)).toBe(2);
        expect(getComRefCount(ib)).toBe(2);
        expect(data.retainedRefs).toEqual([vb, ib]); // the unbound slot retains nothing

        retainStateBlockRefs(data); // a re-Capture must not stack references
        expect(getComRefCount(vb)).toBe(2);

        releaseStateBlockRefs(data);
        expect(getComRefCount(vb)).toBe(1);
        expect(getComRefCount(ib)).toBe(1);
        releaseStateBlockRefs(data); // idempotent — Apply/dispose must not double-release
        expect(getComRefCount(vb)).toBe(1);
    });
});

describe("stream state entry typing", () => {
    test("the narrow entry type covers exactly the two binding ops", () => {
        const entries: StreamStateEntry[] = [
            { op: "streamSource", stream: 0, vbPtr: 0, offset: 0, stride: 0 },
            { op: "indices", ibPtr: 0 },
        ];
        expect(entries.map(e => e.op)).toEqual(["streamSource", "indices"]);
    });
});
