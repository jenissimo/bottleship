/**
 * Multi-stream vertex input, shared by the D3D8 and D3D9 backends.
 *
 * A vertex declaration addresses its elements as (stream, offset): the same vertex index
 * steps every referenced stream by THAT stream's own stride. Binding stream 0 alone and
 * building the layout from its elements does not fail loudly — the geometry still
 * rasterizes, just without whatever the other streams carried (UVs, colours) — so the
 * symptom is flat untextured output with no error raised anywhere. This module is the one
 * place that decides which streams a declaration needs and how they map onto GPU slots.
 */

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

/** What a backend must resolve for one stream to bind it. */
export interface ResolvedStream {
    buffer: GPUBuffer;
    /** Byte offset of the binding (the guest's OffsetInBytes), before any vertex indexing. */
    offset: number;
    /** Total buffer size in bytes — the binding runs from `offset` to the end. */
    size: number;
    stride: number;
}

/** Stream numbers a declaration references, ascending. */
export function declStreamsUsed(elements: readonly StreamedDeclElement[]): number[] {
    const seen = new Set<number>();
    for (const e of elements) seen.add(e.stream);
    return [...seen].sort((a, b) => a - b);
}

/** Highest stream number a declaration references (0 for a single-stream declaration). */
export function maxDeclStream(elements: readonly StreamedDeclElement[]): number {
    let max = 0;
    for (const e of elements) if (e.stream > max) max = e.stream;
    return max;
}

export interface ExtraStreamCollection {
    /** Bindings for the streams beyond 0 that resolved. */
    bindings: StreamVertexBinding[];
    /** Streams the declaration references but nothing is bound to. */
    missing: number[];
}

/**
 * Gather GPU bindings for the streams beyond 0 that `elements` references.
 *
 * `firstVertex` is folded into the byte offset only when the caller draws from vertex 0
 * (the D3D8 convention); pass 0 to keep the guest's own offset and let the draw's
 * firstVertex step each stream by its stride, which is what D3D9 does.
 *
 * Streams nothing is bound to come back in `missing` rather than aborting: real D3D9
 * binds an empty buffer for them and still issues the draw (DXVK D3D9DeviceEx::
 * BindVertexBuffer with a null buffer), so dropping the draw would lose geometry the
 * hardware would have rasterized. Callers that cannot express an empty binding must
 * substitute one — see zeroStreamBuffer.
 */
export function collectExtraStreamBindings(
    elements: readonly StreamedDeclElement[],
    resolve: (stream: number) => ResolvedStream | null,
    firstVertex = 0,
): ExtraStreamCollection {
    const bindings: StreamVertexBinding[] = [];
    const missing: number[] = [];
    for (const stream of declStreamsUsed(elements)) {
        if (stream === 0) continue;
        const src = resolve(stream);
        if (!src || src.stride <= 0) { missing.push(stream); continue; }
        const offset = src.offset + firstVertex * src.stride;
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
