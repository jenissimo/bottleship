/**
 * Multi-stream vertex input, shared by the D3D8 and D3D9 backends.
 *
 * A vertex declaration addresses its elements as (stream, offset): the same vertex index
 * steps every referenced stream by THAT stream's own stride. The declaration therefore
 * decides only WHICH slots exist and where an attribute sits inside a vertex; how far apart
 * vertices are, and where a stream begins, comes from SetStreamSource alone. This module owns
 * that split — the binding table (the single writable home of the per-slot state), the
 * per-draw binding plan the recorder consumes, and the two rules a GPU layout is derived by.
 */

/** D3DCAPS9.MaxStreams as we advertise it (caps.ts, offset 188). */
export const MAX_VERTEX_STREAMS = 16;

/** Vertex-stream binding: slot = D3D stream number. */
export interface StreamVertexBinding {
    slot: number;
    buffer: GPUBuffer;
    offset: number;
    size: number;
}

/** The (stream, …) shape both backends' declaration elements share. */
export interface StreamedDeclElement {
    stream: number;
}

/**
 * Per-slot stream state, flat. THE source of truth for every slot including 0 — written only
 * by SetStreamSource (and, once it exists, SetStreamSourceFreq), read by the draw paths, the
 * pipeline key and GetStreamSource. A second copy of slot 0 kept beside it is how slot 0 and
 * slots 1+ drift apart, so anything else that needs stream state holds a VIEW onto this.
 */
export class StreamBindingTable {
    /** Vertex-buffer COM pointer per slot — what GetStreamSource must answer. 0 = unbound. */
    readonly ptr = new Uint32Array(MAX_VERTEX_STREAMS);
    /** Vertex-buffer registry index per slot; -1 = nothing bound. What a draw binds. */
    readonly bufferIndex = new Int32Array(MAX_VERTEX_STREAMS).fill(-1);
    /** OffsetInBytes — where the stream begins. Never carries a vertex index (see the plan). */
    readonly offsetBytes = new Uint32Array(MAX_VERTEX_STREAMS);
    /** Stride — how far apart vertices are. 0 means the guest bound none. */
    readonly strideBytes = new Uint32Array(MAX_VERTEX_STREAMS);

    /** Returns true when the slot's state actually changed (callers use it to skip work). */
    set(slot: number, ptr: number, bufferIndex: number, offsetBytes: number, strideBytes: number): boolean {
        const changed = this.ptr[slot] !== ptr || this.bufferIndex[slot] !== bufferIndex
            || this.offsetBytes[slot] !== offsetBytes || this.strideBytes[slot] !== strideBytes;
        this.ptr[slot] = ptr;
        this.bufferIndex[slot] = bufferIndex;
        this.offsetBytes[slot] = offsetBytes;
        this.strideBytes[slot] = strideBytes;
        return changed;
    }

    clear(slot: number): boolean {
        return this.set(slot, 0, -1, 0, 0);
    }

    /** A slot a draw can fetch from: a buffer AND a stride (a 0 stride reads one vertex forever). */
    isBound(slot: number): boolean {
        return this.bufferIndex[slot]! >= 0 && this.strideBytes[slot]! > 0;
    }
}

/**
 * The vertex-buffer bindings of ONE draw — every slot its pipeline declares, slot 0 included.
 *
 * Reused across draws: the recorder copies each entry into the frame's flat command arrays
 * synchronously, so nothing outlives the recordDraw call and the steady state allocates
 * nothing.
 */
export class StreamBindingPlan {
    private readonly pool: StreamVertexBinding[] = [];
    /** Number of valid entries. */
    count = 0;
    /** Bitmask of the slots in `pool[0..count)` — the same mask the pipeline was built from. */
    slotMask = 0;

    reset(): void {
        this.count = 0;
        this.slotMask = 0;
    }

    add(slot: number, buffer: GPUBuffer, offset: number, size: number): void {
        const held = this.pool[this.count];
        if (held) {
            held.slot = slot; held.buffer = buffer; held.offset = offset; held.size = size;
        } else {
            this.pool.push({ slot, buffer, offset, size });
        }
        this.count++;
        this.slotMask |= 1 << slot;
    }

    at(i: number): StreamVertexBinding {
        return this.pool[i]!;
    }

    /** The binding for one slot, or null when the plan does not cover it. */
    find(slot: number): StreamVertexBinding | null {
        if (((this.slotMask >>> slot) & 1) === 0) return null;
        for (let i = 0; i < this.count; i++) if (this.pool[i]!.slot === slot) return this.pool[i]!;
        return null;
    }
}

/**
 * The stride a slot's GPU layout steps by.
 *
 * The BOUND stride wins: it may legitimately exceed the packed size (the vertex carries data
 * this declaration names no attribute for), and it may legitimately be smaller. Raising it to
 * a packed size that overshoots reads every vertex after the first out of its successor and
 * runs the draw past the buffer's end. The packed size is the fallback for an UNBOUND slot,
 * never a floor.
 */
export function slotArrayStride(boundStride: number, packedSize: number): number {
    return boundStride > 0 ? boundStride : packedSize;
}

/**
 * Where a binding starts and how big it is: from the guest's OffsetInBytes to the END of the
 * buffer. The draw's firstVertex/startVertex/baseVertex is applied by the GPU to every slot
 * uniformly and must NEVER be folded in here — folding it in double-counts it on the slots the
 * GPU also steps, and sizes the binding as if the earlier vertices did not exist.
 */
export function bindingSize(bufferSize: number, offsetBytes: number): number {
    return bufferSize - offsetBytes;
}

/**
 * WebGPU's default `maxVertexBuffers`. D3D9 advertises 16 streams and a declaration may name
 * any of them, but a pipeline that declares a slot past this limit fails to build — and a
 * throw out of createRenderPipeline costs the draw that asked for it plus every draw that
 * shared the frame. Callers refuse such a declaration up front instead.
 */
export const MAX_VERTEX_BUFFER_SLOTS = 8;

/** True when a slot mask names a stream WebGPU cannot bind (see MAX_VERTEX_BUFFER_SLOTS). */
export function slotMaskExceedsLimit(slotMask: number, maxSlots = MAX_VERTEX_BUFFER_SLOTS): boolean {
    return (slotMask >>> maxSlots) !== 0;
}

/** Bytes an attribute of `format` reads out of the vertex. */
export function vertexFormatSize(format: GPUVertexFormat): number {
    if (format === "unorm10-10-10-2") return 4;
    const m = /^(uint|sint|unorm|snorm|float)(8|16|32)(?:x(2|3|4))?$/.exec(format);
    // An unknown format is not a licence to under-size the vertex: assume the widest.
    if (!m) return 16;
    return (Number(m[2]) / 8) * (m[3] ? Number(m[3]) : 1);
}

/** arrayStride per slot from the layouts a pipeline was built with (index = slot, 0 = hole). */
export function layoutStrides(buffers: readonly (GPUVertexBufferLayout | null | undefined)[]): number[] {
    return buffers.map(b => b?.arrayStride ?? 0);
}

/**
 * End offset of the FURTHEST attribute in each slot's layout — the second number WebGPU's
 * non-indexed draw rule needs. It sizes the LAST vertex by where its final attribute ends,
 * not by a whole stride, so a buffer that exactly fits N vertices whose vertex carries
 * trailing padding is legal. Sizing it by the stride instead rejects that buffer and
 * substitutes zeros where hardware would have drawn.
 */
export function layoutAttributeEnds(buffers: readonly (GPUVertexBufferLayout | null | undefined)[]): number[] {
    return buffers.map(b => {
        if (!b) return 0;
        let end = 0;
        for (const a of b.attributes) end = Math.max(end, a.offset + vertexFormatSize(a.format));
        return end;
    });
}

/**
 * Bytes a NON-indexed draw reads out of one slot: WebGPU's exact rule,
 * (firstVertex + vertexCount - 1) * arrayStride + <end of the last attribute>.
 * `attrEnd` falls back to the stride for a caller that has no layout to read it from.
 */
export function vertexRangeEndBytes(
    firstVertex: number, vertexCount: number, arrayStride: number, attrEnd: number,
): number {
    if (vertexCount <= 0) return 0;
    return (firstVertex + vertexCount - 1) * arrayStride + (attrEnd > 0 ? attrEnd : arrayStride);
}

/**
 * The stand-in region for a slot a draw outruns: `size` bytes of which the first `copyBytes`
 * are the slot's real bytes and the rest reads zero.
 *
 * That split IS hardware robustness — Vulkan/D3D9 zero only what lies past the end of the
 * buffer, so the vertices that ARE in range must keep their own colours and UVs. Zeroing the
 * whole slot instead turns a mesh missing its tail into a mesh drawn entirely from the origin
 * with zeroed attributes. `copyBytes` is a 4-byte multiple because that is the unit
 * copyBufferToBuffer works in; `available` is 0 for a source that cannot be copied at all.
 */
export function padRegion(need: number, available: number): { size: number; copyBytes: number } {
    const size = (need + 3) & ~3;
    const copyBytes = Math.max(0, Math.min(available, size)) & ~3;
    return { size, copyBytes };
}

/** Bitmask of the stream numbers a declaration references. */
export function declStreamMask(elements: readonly StreamedDeclElement[]): number {
    let mask = 0;
    for (const e of elements) mask |= 1 << e.stream;
    return mask;
}

/** The slots in a mask, ascending. Diagnostics only — draw paths iterate the mask directly. */
export function slotsInMask(mask: number): number[] {
    const out: number[] = [];
    for (let s = 0; s < MAX_VERTEX_STREAMS; s++) if ((mask >>> s) & 1) out.push(s);
    return out;
}

/** What a backend must resolve for one stream to bind it. */
export interface ResolvedStream {
    buffer: GPUBuffer;
    /** Byte offset of the binding (the guest's OffsetInBytes), before any vertex indexing. */
    offset: number;
    /** Total buffer size in bytes — the binding runs from `offset` to the end. */
    size: number;
    stride: number;
}

export interface ExtraStreamCollection {
    /** Bindings for the streams beyond 0 that resolved. */
    bindings: StreamVertexBinding[];
    /** Streams the declaration references but nothing is bound to. */
    missing: number[];
}

/**
 * D3D8 ONLY — gather bindings for the streams beyond 0, with `foldedFirstVertex` folded into
 * each stream's byte offset.
 *
 * That fold is the D3D8 backend's own convention: it draws its converted geometry from vertex
 * 0, so the base vertex has to reach the bindings some other way. D3D9 must NOT do this (the
 * GPU applies firstVertex to every slot itself — see bindingSize), which is why the parameter
 * is required rather than defaulted: the convention belongs at the call site, not hidden in a
 * shared helper.
 *
 * Streams nothing is bound to come back in `missing` rather than aborting: real D3D9 binds an
 * empty buffer for them and still issues the draw (DXVK D3D9DeviceEx::BindVertexBuffer with a
 * null buffer). Callers that cannot express an empty binding substitute one — see
 * zeroStreamBuffer.
 */
export function collectExtraStreamBindings(
    elements: readonly StreamedDeclElement[],
    resolve: (stream: number) => ResolvedStream | null,
    foldedFirstVertex: number,
): ExtraStreamCollection {
    const bindings: StreamVertexBinding[] = [];
    const missing: number[] = [];
    const mask = declStreamMask(elements);
    for (let stream = 1; stream < MAX_VERTEX_STREAMS; stream++) {
        if (((mask >>> stream) & 1) === 0) continue;
        const src = resolve(stream);
        if (!src || src.stride <= 0) { missing.push(stream); continue; }
        const offset = src.offset + foldedFirstVertex * src.stride;
        if (offset >= src.size) { missing.push(stream); continue; }
        bindings.push({ slot: stream, buffer: src.buffer, offset, size: src.size - offset });
    }
    return { bindings, missing };
}

/**
 * A zero-filled buffer to bind where the declaration wants a stream and the guest bound
 * none. WebGPU has no null vertex buffer, so this stands in for the empty binding real
 * D3D9 makes — the attributes read as zero and the draw still happens. Large enough that
 * an ordinary vertex range stays in bounds; grown on demand, one per GPU device.
 */
const zeroBuffers = new WeakMap<GPUDevice, { buffer: GPUBuffer; size: number }>();

export function zeroStreamBuffer(device: GPUDevice, minSize: number): GPUBuffer {
    const held = zeroBuffers.get(device);
    if (held && held.size >= minSize) return held.buffer;
    const size = Math.max(minSize, (held?.size ?? 0) * 2, 64 * 1024);
    const buffer = device.createBuffer({ size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    zeroBuffers.set(device, { buffer, size });
    return buffer;
}
