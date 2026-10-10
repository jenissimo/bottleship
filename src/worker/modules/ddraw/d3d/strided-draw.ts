/**
 * DX6/7's x86 D3DDRAWPRIMITIVESTRIDEDDATA is twelve { pointer, byte stride }
 * pairs. Only FVF-selected streams are read; a zero stride broadcasts one
 * attribute. Gather into reusable guest scratch, then use the ordinary draw
 * path so transforms, textures, batching and frame capture stay identical.
 */
import type { DDrawContext } from "../context";
import type { DrawHandler } from "./types";
import type { ThunkImplementation } from "../../../core/thunking/thunk-dispatcher";
import { isValidAddress } from "../../../core/memory/address-guard";
import { MAX_ALLOC_BYTES } from "../../../core/cpu/emulator-config";

const D3D_OK = 0;
const DDERR_INVALIDPARAMS = 0x80070057;
const DDERR_UNSUPPORTED = 0x80004001;
const DDERR_OUTOFMEMORY = 0x8007000e;
const DESC_BYTES = 96;

type Memory = DDrawContext["process"]["memory"];
interface Scratch { addr: number; bytes: number }
// Numbers only: a guest view must never survive a thunk or memory growth.
const scratchByMemory = new WeakMap<Memory, Scratch>();

export function freeStridedDrawScratch(memory: Memory): void {
    const scratch = scratchByMemory.get(memory);
    if (scratch?.addr) memory.free(scratch.addr);
    scratchByMemory.delete(memory);
}

function validRange(mem: Uint8Array, ptr: number, bytes: number, perms: "r" | "rw"): boolean {
    return ptr !== 0 && bytes > 0 && ptr + bytes <= mem.length
        && ptr + bytes <= 0x100000000 && isValidAddress(mem, ptr, bytes, perms);
}

// All callers validate the complete descriptor before reading its DWORDs.
function u32(mem: Uint8Array, ptr: number): number {
    return (mem[ptr] | mem[ptr + 1] << 8 | mem[ptr + 2] << 16 | mem[ptr + 3] << 24) >>> 0;
}

export function createStridedDrawHandlers(context: DDrawContext, drawHandler: DrawHandler): {
    draw: ThunkImplementation;
    drawIndexed: ThunkImplementation;
} {
    // Reuse the stream metadata too: no per-vertex arrays, subarrays or objects.
    const pointers = new Float64Array(12);
    const strides = new Float64Array(12);
    const widths = new Uint8Array(12);

    const submit = (args: number[], indexed: boolean): number => {
        const primitive = args[1] >>> 0;
        const fvf = args[2] >>> 0;
        const desc = args[3] >>> 0;
        const count = args[4] >>> 0;
        const indices = indexed ? args[5] >>> 0 : 0;
        const indexCount = indexed ? args[6] >>> 0 : 0;
        // Empty submissions do not dereference the descriptor or streams.
        if (!count || (indexed && !indexCount)) return D3D_OK;
        if (primitive < 1 || primitive > 6) return DDERR_INVALIDPARAMS;
        const position = fvf & 0x400e;
        const texCount = (fvf >>> 8) & 15;
        if (texCount > 8) return DDERR_INVALIDPARAMS;
        // The descriptor has no blend-weight stream. Do not silently
        // reinterpret blended positions as XYZ and lose their attributes.
        if (position !== 2 && position !== 4) return DDERR_UNSUPPORTED;
        if (position === 4 && (fvf & 0x10)) return DDERR_INVALIDPARAMS;
        // 0x20 is RESERVED1 in DX6/7 (D3DFVF_LVERTEX), not DX8's PSIZE.
        // There is no reserved DWORD in separate streams; omit it when
        // normalizing to the shared, later-DX interleaved FVF converter.
        const packedFvf = fvf & ~0x20;

        let mem = context.process.getCurrentMemory();
        if (!validRange(mem, desc, DESC_BYTES, "r")) return DDERR_INVALIDPARAMS;
        if (indexed && !validRange(mem, indices, indexCount * 2, "r")) return DDERR_INVALIDPARAMS;

        widths.fill(0);
        widths[0] = position === 4 ? 16 : 12;
        if (fvf & 0x10) widths[1] = 12;
        if (fvf & 0x40) widths[2] = 4;
        if (fvf & 0x80) widths[3] = 4;
        for (let i = 0; i < texCount; i++) {
            const dimensions = (fvf >>> (16 + i * 2)) & 3;
            widths[4 + i] = (dimensions === 3 ? 1 : dimensions + 2) * 4;
        }

        let vertexBytes = 0;
        for (let stream = 0; stream < 12; stream++) {
            const width = widths[stream];
            if (!width) continue;
            const ptr = u32(mem, desc + stream * 8);
            const stride = u32(mem, desc + stream * 8 + 4);
            const extent = (count - 1) * stride + width;
            if (!validRange(mem, ptr, extent, "r")) return DDERR_INVALIDPARAMS;
            pointers[stream] = ptr;
            strides[stream] = stride;
            vertexBytes += width;
        }
        const bytes = count * vertexBytes;
        if (bytes > MAX_ALLOC_BYTES) return DDERR_OUTOFMEMORY;
        const memory = context.process.memory;
        let scratch = scratchByMemory.get(memory);
        if (!scratch) {
            scratch = { addr: 0, bytes: 0 };
            scratchByMemory.set(memory, scratch);
        }
        if (scratch.bytes < bytes) {
            let capacity = Math.max(scratch.bytes, 4096);
            while (capacity < bytes) capacity *= 2;
            let addr: number;
            try { addr = memory.alloc(capacity); }
            catch { return DDERR_OUTOFMEMORY; }
            if (!addr) return DDERR_OUTOFMEMORY;
            if (scratch.addr) memory.free(scratch.addr);
            scratch.addr = addr;
            scratch.bytes = capacity;
        }
        // alloc can grow WASM and detach the pre-allocation view.
        mem = context.process.getCurrentMemory();
        if (!validRange(mem, scratch.addr, bytes, "rw")) return DDERR_INVALIDPARAMS;
        let dst = scratch.addr;
        for (let vertex = 0; vertex < count; vertex++) {
            for (let stream = 0; stream < 12; stream++) {
                const width = widths[stream];
                if (!width) continue;
                const src = pointers[stream] + vertex * strides[stream];
                for (let byte = 0; byte < width; byte++) mem[dst++] = mem[src + byte];
            }
        }
        drawHandler.handleDrawPrimitive(args[0] >>> 0, primitive, packedFvf,
            scratch.addr, count, mem, indexed, indices, indexCount);
        return D3D_OK;
    };

    return {
        draw: (_ctx, _mem, args) => submit(args, false),
        drawIndexed: (_ctx, _mem, args) => submit(args, true),
    };
}
