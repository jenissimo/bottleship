/**
 * Direct3D v1 execute buffers — the DirectX 2/3 rendering model.
 *
 * Instead of DrawPrimitive, a v1 title fills one buffer with vertices plus an
 * opcode stream (D3DOP_*) and submits it via IDirect3DDevice::Execute. This
 * module owns the buffer object and the interpreter that replays that stream
 * onto the same device state + draw path the Device2/3 handlers use, so an
 * execute-buffer title lands in exactly one renderer with everything else.
 *
 * Vertex flow: D3DOP_PROCESSVERTICES names a source range and a destination
 * index base; D3DOP_TRIANGLE then indexes the DESTINATION space. Destination
 * blocks ACCUMULATE — several PROCESSVERTICES records fill disjoint ranges of
 * one destination buffer and a later triangle list indexes across all of them —
 * so we materialise that buffer (every legacy vertex layout is 32 bytes, so a
 * block is a straight copy) and draw from it with the guest's own indices.
 */
import type { ThunkImplementation } from "../../../core/thunking/thunk-dispatcher";
import type { DDrawContext } from "../context";
import { Logger, LogCategory } from "../../../core/logger";
import { ComObjectFactory } from "../../../core/com/base-com-object";
import type { Direct3DExecuteBufferObject } from "../com-objects";
import { allocateComObject, IID_IDirect3DExecuteBuffer } from "../constants";
import type { createDrawHandler } from "./draw-handler";
import { readGuidFromMem } from "../../../core/com/typelib/typelib-types";
import { isValidAddress } from "../../../core/memory/address-guard";

const D3D_OK = 0;
const E_POINTER = 0x80004003;
const E_NOINTERFACE = 0x80004002;
const E_FAIL = 0x80004005;
const D3DERR_INVALIDCALL = 0x8876086c;
const DDERR_INVALIDPARAMS = 0x80070057; // ddraw.h aliases this onto E_INVALIDARG
const DDERR_ALREADYINITIALIZED = 0x88760005; // MAKE_DDHRESULT(5)
const DDERR_UNSUPPORTED = 0x80004001; // ddraw.h: DDERR_UNSUPPORTED == E_NOTIMPL
const IID_IUNKNOWN = "00000000-0000-0000-c000-000000000046";

// D3DOPCODE
const D3DOP_POINT = 1;
const D3DOP_LINE = 2;
const D3DOP_TRIANGLE = 3;
const D3DOP_MATRIXLOAD = 4;
const D3DOP_MATRIXMULTIPLY = 5;
const D3DOP_STATETRANSFORM = 6;
const D3DOP_STATELIGHT = 7;
const D3DOP_STATERENDER = 8;
const D3DOP_PROCESSVERTICES = 9;
const D3DOP_TEXTURELOAD = 10;
const D3DOP_EXIT = 11;
const D3DOP_BRANCHFORWARD = 12;
const D3DOP_SPAN = 13;
const D3DOP_SETSTATUS = 14;

// D3DSETSTATUS flags (which halves of the D3DSTATUS the record carries)
const D3DSETSTATUS_STATUS = 0x1;
const D3DSETSTATUS_EXTENTS = 0x2;

// D3DPRIMITIVETYPE
const D3DPT_POINTLIST = 1;
const D3DPT_LINELIST = 2;
const D3DPT_TRIANGLELIST = 4;

// D3DPROCESSVERTICES flags
const D3DPROCESSVERTICES_OPMASK = 0x7;
const D3DPROCESSVERTICES_TRANSFORMLIGHT = 0;
const D3DPROCESSVERTICES_TRANSFORM = 1;
const D3DPROCESSVERTICES_COPY = 2;

// Every legacy vertex layout is 32 bytes wide.
const VERTEX_STRIDE = 32;
const D3DFVF_VERTEX = 0x112;   // XYZ | NORMAL | TEX1 — untransformed + unlit, full FFP
const D3DFVF_LVERTEX = 0x1e2;  // XYZ | RESERVED1 | DIFFUSE | SPECULAR | TEX1 — pre-lit
const D3DFVF_TLVERTEX = 0x1c4; // XYZRHW | DIFFUSE | SPECULAR | TEX1 — already transformed

/**
 * Source layout for a PROCESSVERTICES op. The three ops feed three DIFFERENT
 * structs, and only COPY skips the transform: TRANSFORM takes D3DLVERTEX, whose
 * diffuse colour (alpha included) the app already computed — reading it as a
 * D3DVERTEX would parse that colour out of the normal's bytes, so a translucent
 * sprite or blob shadow comes out as an opaque block.
 */
function fvfForProcessOp(op: number): number {
    if (op === D3DPROCESSVERTICES_COPY) return D3DFVF_TLVERTEX;
    if (op === D3DPROCESSVERTICES_TRANSFORM) return D3DFVF_LVERTEX;
    return D3DFVF_VERTEX; // TRANSFORMLIGHT (and the light-only variants)
}

const MATRIX_BYTES = 64;
/** sizeof(D3DEXECUTEDATA): 6 DWORDs + D3DSTATUS (2 DWORDs + D3DRECT). */
const D3DEXECUTEDATA_SIZE = 48;
/** sizeof(D3DEXECUTEBUFFERDESC): dwSize, dwFlags, dwCaps, dwBufferSize, lpData. */
const EXEC_BUFFER_DESC_BYTES = 20;

/** One PROCESSVERTICES record's output inside the accumulated destination buffer. */
interface VertexBlock {
    base: number;
    count: number;
    fvf: number;
}

/** Guest scratch that grows for the life of the process; module-level so a reset can
 *  hand the blocks back instead of stranding them on the heap. */
interface GuestScratch { addr: number; bytes: number }
const indexScratch: GuestScratch = { addr: 0, bytes: 0 };
const vertexScratch: GuestScratch = { addr: 0, bytes: 0 };

/** Release the interpreter's guest scratch (DDraw.reset). */
export function freeExecuteBufferScratch(memory: { free(addr: number): void }): void {
    for (const s of [indexScratch, vertexScratch]) {
        if (s.addr) memory.free(s.addr);
        s.addr = 0;
        s.bytes = 0;
    }
}

export const createExecuteBufferExports = (
    context: DDrawContext,
    drawHandler: ReturnType<typeof createDrawHandler>,
    d3dExports: Record<string, ThunkImplementation>,
): Record<string, ThunkImplementation> => {
    const exports: Record<string, ThunkImplementation> = {};
    const resourceProvider = context.resourceProvider;

    const ensureScratch = (s: GuestScratch, bytes: number): number => {
        if (s.bytes >= bytes) return s.addr;
        const memory = context.process.memory;
        if (s.addr) memory.free(s.addr);
        const size = Math.max(bytes, 4096);
        s.addr = memory.alloc(size);
        s.bytes = s.addr ? size : 0;
        return s.addr;
    };

    const getBuffer = (addr: number): Direct3DExecuteBufferObject | null =>
        (resourceProvider.getComObjectByAddress(addr) as Direct3DExecuteBufferObject | null) ?? null;

    // ─── IDirect3DExecuteBuffer ──────────────────────────────────────────────

    exports["IDirect3DExecuteBuffer_QueryInterface"] = (ctx, mem, args) => {
        const obj = getBuffer(args[0]);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const riid = args[1] >>> 0;
        const ppvObject = args[2] >>> 0;
        if (!ppvObject || ppvObject + 4 > mem.length || !riid || riid + 16 > mem.length) return E_POINTER;
        if (!obj) {
            view.setUint32(ppvObject, 0, true);
            return E_NOINTERFACE;
        }
        const iid = readGuidFromMem(mem, riid);
        if (iid !== IID_IUNKNOWN && iid !== IID_IDirect3DExecuteBuffer) {
            view.setUint32(ppvObject, 0, true);
            return E_NOINTERFACE;
        }
        view.setUint32(ppvObject, args[0] >>> 0, true);
        obj.addRef();
        return D3D_OK;
    };
    exports["IDirect3DExecuteBuffer_AddRef"] = (ctx, mem, args) => getBuffer(args[0])?.addRef() ?? 0;
    exports["IDirect3DExecuteBuffer_Release"] = (ctx, mem, args) => getBuffer(args[0])?.release() ?? 0;
    exports["IDirect3DExecuteBuffer_Initialize"] = () => DDERR_ALREADYINITIALIZED;

    /** Lock hands back the guest pointer + size in the caller's D3DEXECUTEBUFFERDESC. */
    exports["IDirect3DExecuteBuffer_Lock"] = (ctx, mem, args) => {
        const obj = getBuffer(args[0]);
        const lpDesc = args[1];
        if (!obj || !lpDesc || !isValidAddress(mem, lpDesc, EXEC_BUFFER_DESC_BYTES, "rw")) return D3DERR_INVALIDCALL;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lpDesc + 8, 1, true);                   // dwCaps = D3DDEBCAPS_SYSTEMMEMORY
        view.setUint32(lpDesc + 12, obj.getDataSize(), true);  // dwBufferSize
        view.setUint32(lpDesc + 16, obj.getDataAddr(), true);  // lpData
        view.setUint32(lpDesc + 4, 0x2 | 0x4, true);           // D3DDEB_BUFSIZE | D3DDEB_LPDATA
        obj.setLocked(true);
        return D3D_OK;
    };

    exports["IDirect3DExecuteBuffer_Unlock"] = (ctx, mem, args) => {
        const obj = getBuffer(args[0]);
        if (!obj) return D3DERR_INVALIDCALL;
        obj.setLocked(false);
        return D3D_OK;
    };

    /**
     * The execute data is what the interpreter derives its program counter from, so it is
     * validated HERE rather than trusted at Execute time: an uninitialised D3DEXECUTEDATA
     * would otherwise point the opcode reader at arbitrary guest memory. Wine checks dwSize
     * and clamps every range to the buffer; so do we, and we reject rather than clamp the
     * instruction range because a truncated opcode stream is not a program.
     */
    exports["IDirect3DExecuteBuffer_SetExecuteData"] = (ctx, mem, args) => {
        const obj = getBuffer(args[0]);
        const lpData = args[1];
        if (!obj || !lpData || !isValidAddress(mem, lpData, D3DEXECUTEDATA_SIZE)) return D3DERR_INVALIDCALL;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (view.getUint32(lpData, true) !== D3DEXECUTEDATA_SIZE) return DDERR_INVALIDPARAMS;

        const bufferSize = obj.getDataSize();
        const vertexOffset = view.getUint32(lpData + 4, true);
        const vertexCount = view.getUint32(lpData + 8, true);
        const instructionOffset = view.getUint32(lpData + 12, true);
        const instructionLength = view.getUint32(lpData + 16, true);
        const withinBuffer = (offset: number, length: number): boolean =>
            offset <= bufferSize && length <= bufferSize - offset;
        if (!withinBuffer(vertexOffset, vertexCount * VERTEX_STRIDE)
            || !withinBuffer(instructionOffset, instructionLength)) {
            Logger.warn(LogCategory.DDRAW,
                `IDirect3DExecuteBuffer_SetExecuteData: vertices ${vertexOffset}+${vertexCount * VERTEX_STRIDE} / ` +
                `instructions ${instructionOffset}+${instructionLength} do not fit the ${bufferSize}-byte buffer`);
            return DDERR_INVALIDPARAMS;
        }

        obj.setExecuteData({
            vertexOffset,
            vertexCount,
            instructionOffset,
            instructionLength,
            hVertexOffset: view.getUint32(lpData + 20, true),
            statusFlags: view.getUint32(lpData + 24, true),
            status: view.getUint32(lpData + 28, true),
            statusExtent: {
                left: view.getInt32(lpData + 32, true),
                top: view.getInt32(lpData + 36, true),
                right: view.getInt32(lpData + 40, true),
                bottom: view.getInt32(lpData + 44, true),
            },
        });
        return D3D_OK;
    };

    // Tests show dwSize is ignored on the way out: the whole struct comes back, dsStatus
    // included — that is how an app reads what D3DOP_SETSTATUS left behind.
    exports["IDirect3DExecuteBuffer_GetExecuteData"] = (ctx, mem, args) => {
        const obj = getBuffer(args[0]);
        const lpData = args[1];
        if (!obj || !lpData || !isValidAddress(mem, lpData, D3DEXECUTEDATA_SIZE)) return D3DERR_INVALIDCALL;
        const d = obj.getExecuteData();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lpData, D3DEXECUTEDATA_SIZE, true);
        view.setUint32(lpData + 4, d.vertexOffset, true);
        view.setUint32(lpData + 8, d.vertexCount, true);
        view.setUint32(lpData + 12, d.instructionOffset, true);
        view.setUint32(lpData + 16, d.instructionLength, true);
        view.setUint32(lpData + 20, d.hVertexOffset, true);
        view.setUint32(lpData + 24, d.statusFlags, true);
        view.setUint32(lpData + 28, d.status, true);
        view.setInt32(lpData + 32, d.statusExtent.left, true);
        view.setInt32(lpData + 36, d.statusExtent.top, true);
        view.setInt32(lpData + 40, d.statusExtent.right, true);
        view.setInt32(lpData + 44, d.statusExtent.bottom, true);
        return D3D_OK;
    };

    // Validate(this, lpdwOffset, lpFunc, lpUserArg, dwReserved) and Optimize were never
    // implemented by DirectX itself — both always fail.
    exports["IDirect3DExecuteBuffer_Validate"] = () => DDERR_UNSUPPORTED;
    exports["IDirect3DExecuteBuffer_Optimize"] = () => DDERR_UNSUPPORTED;

    // ─── Matrix handles ──────────────────────────────────────────────────────
    // A D3DMATRIXHANDLE is opaque; we hand out the guest address of the 64-byte
    // matrix itself, so D3DOP_STATETRANSFORM can pass it straight to SetTransform.

    const matrices = new Set<number>();

    exports["IDirect3DDevice_CreateMatrix"] = (ctx, mem, args) => {
        const lpHandle = args[1];
        if (!lpHandle) return E_POINTER;
        const addr = context.process.memory.alloc(MATRIX_BYTES);
        if (!addr) return E_FAIL;
        // Identity, so a matrix used before SetMatrix behaves like D3D's.
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < 16; i++) view.setFloat32(addr + i * 4, i % 5 === 0 ? 1 : 0, true);
        matrices.add(addr);
        if (!lpHandle || !isValidAddress(mem, lpHandle, 4, "rw")) return E_POINTER;
        view.setUint32(lpHandle, addr, true);
        return D3D_OK;
    };

    exports["IDirect3DDevice_SetMatrix"] = (ctx, mem, args) => {
        const handle = args[1];
        const lpMatrix = args[2];
        if (!handle || !lpMatrix || !matrices.has(handle)) return D3DERR_INVALIDCALL;
        mem.copyWithin(handle, lpMatrix, lpMatrix + MATRIX_BYTES);
        return D3D_OK;
    };

    exports["IDirect3DDevice_GetMatrix"] = (ctx, mem, args) => {
        const handle = args[1];
        const lpMatrix = args[2];
        if (!handle || !lpMatrix || !matrices.has(handle)) return D3DERR_INVALIDCALL;
        mem.copyWithin(lpMatrix, handle, handle + MATRIX_BYTES);
        return D3D_OK;
    };

    exports["IDirect3DDevice_DeleteMatrix"] = (ctx, mem, args) => {
        const handle = args[1];
        if (!handle || !matrices.delete(handle)) return D3DERR_INVALIDCALL;
        context.process.memory.free(handle);
        return D3D_OK;
    };

    // ─── Device: buffer creation + execution ─────────────────────────────────

    exports["IDirect3DDevice_CreateExecuteBuffer"] = (ctx, mem, args) => {
        const lpDesc = args[1];
        const lplpBuffer = args[2];
        if (!lpDesc || !lplpBuffer) return E_POINTER;
        if (!isValidAddress(mem, lpDesc, EXEC_BUFFER_DESC_BYTES, "r")
            || !isValidAddress(mem, lplpBuffer, 4, "rw")) return E_POINTER;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lplpBuffer, 0, true);
        const size = view.getUint32(lpDesc + 12, true); // dwBufferSize
        if (!size) return D3DERR_INVALIDCALL;

        const vtableAddr = context.vtables.IDirect3DExecuteBuffer?.address;
        if (!vtableAddr) return E_NOINTERFACE;

        const dataAddr = context.process.memory.alloc(size);
        if (!dataAddr) return E_FAIL;

        const obj = ComObjectFactory.create(IID_IDirect3DExecuteBuffer, vtableAddr) as Direct3DExecuteBufferObject | null;
        if (!obj) {
            context.process.memory.free(dataAddr);
            return E_FAIL;
        }
        obj.setData(dataAddr, size);

        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        view.setUint32(lplpBuffer, objAddr, true);
        resourceProvider.mapAddressToHandle(objAddr, obj.handle);

        Logger.log(LogCategory.DDRAW,
            `IDirect3DDevice_CreateExecuteBuffer -> 0x${objAddr.toString(16)} data=0x${dataAddr.toString(16)} size=${size}`);
        return D3D_OK;
    };

    /** Run one device method by name with a synthetic argument list. */
    const call = (name: string, ctx: any, mem: Uint8Array, args: number[]): unknown => {
        const fn = d3dExports[name];
        return fn ? fn(ctx, mem, args) : undefined;
    };

    const isPromise = (v: unknown): v is Promise<unknown> =>
        !!v && typeof (v as { then?: unknown }).then === "function";

    exports["IDirect3DDevice_Execute"] = (ctx, mem, args): number | Promise<number> => {
        const devicePtr = args[0];
        const bufferPtr = args[1];
        const viewportPtr = args[2];

        const buf = getBuffer(bufferPtr);
        if (!buf) return D3DERR_INVALIDCALL;
        const data = buf.getExecuteData();
        const bufBase = buf.getDataAddr();
        const bufSize = buf.getDataSize();
        if (!bufBase || !data.instructionLength) return D3D_OK;
        // SetExecuteData bounds these against the buffer; re-derive the limit from the
        // allocation itself so a buffer resized since then still cannot be read past.
        const bufEnd = bufBase + bufSize;

        // Execute takes the viewport per call; the draw path reads it off the device.
        if (viewportPtr) call("IDirect3DDevice3_SetCurrentViewport", ctx, mem, [devicePtr, viewportPtr]);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const end = Math.min(bufBase + data.instructionOffset + data.instructionLength, bufEnd);
        let status = data.status;

        // The destination vertex buffer PROCESSVERTICES fills. Blocks accumulate until a
        // draw, and the guest's indices address it directly; the default block is the
        // buffer's own already-transformed vertices, as a v1 title that never processes.
        let dstAddr = bufBase + data.vertexOffset;
        let blocks: VertexBlock[] = [{ base: 0, count: data.vertexCount, fvf: D3DFVF_TLVERTEX }];
        let dstCount = data.vertexCount;
        let accumulating = false;
        let warnedUnknownOpcode = false;

        /** Highest index the current destination buffer can serve, and the layout to draw it with. */
        const blockFor = (idx: number): VertexBlock | undefined =>
            blocks.find((b) => idx >= b.base && idx < b.base + b.count);

        const beginBlocks = (): void => {
            if (accumulating) return;
            accumulating = true;
            blocks = [];
            dstCount = 0;
        };

        /** Copy one PROCESSVERTICES record's source vertices into the destination buffer. */
        const addBlock = (wStart: number, wDest: number, vCount: number, fvf: number): void => {
            const srcAddr = bufBase + data.vertexOffset + wStart * VERTEX_STRIDE;
            const needed = (wDest + vCount) * VERTEX_STRIDE;
            if (!vCount || srcAddr + vCount * VERTEX_STRIDE > bufEnd) return;
            const dst = ensureScratch(vertexScratch, needed);
            if (!dst) return;
            dstAddr = dst;
            mem.copyWithin(dst + wDest * VERTEX_STRIDE, srcAddr, srcAddr + vCount * VERTEX_STRIDE);
            blocks.push({ base: wDest, count: vCount, fvf });
            dstCount = Math.max(dstCount, wDest + vCount);
        };

        /** Pack the strided triangle/line indices into scratch, clamped to the destination
         *  buffer. Returns the scratch address and the layout the draw must use. */
        const packIndices = (base: number, stride: number, count: number, perElem: number)
            : { addr: number; fvf: number } | null => {
            const addr = ensureScratch(indexScratch, count * perElem * 2);
            if (!addr) return null;
            const out = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            let fvf = blocks[0]?.fvf ?? D3DFVF_TLVERTEX;
            let resolved = false;
            for (let i = 0; i < count; i++) {
                for (let k = 0; k < perElem; k++) {
                    let idx = view.getUint16(base + i * stride + k * 2, true);
                    const block = blockFor(idx);
                    if (block) {
                        if (!resolved) { fvf = block.fvf; resolved = true; }
                    } else {
                        idx = 0; // outside every processed block: nothing legitimate to draw
                    }
                    out.setUint16(addr + (i * perElem + k) * 2, idx, true);
                }
            }
            return { addr, fvf };
        };

        const runFrom = (startPc: number): number | Promise<number> => {
            let pc = startPc;

            while (pc + 4 <= end) {
                const opcode = view.getUint8(pc);
                const elemSize = view.getUint8(pc + 1);
                const count = view.getUint16(pc + 2, true);
                const body = pc + 4;
                const next = body + elemSize * count;
                // A guest u16 count times a u8 size spans up to 16 MB; a record set that runs
                // past the buffer is a corrupt stream, not a program to keep interpreting.
                if (next > end) {
                    Logger.warn(LogCategory.DDRAW,
                        `IDirect3DDevice_Execute: opcode ${opcode} at 0x${pc.toString(16)} spans ` +
                        `${elemSize * count} bytes past the instruction range, stopping`);
                    break;
                }

                switch (opcode) {
                    case D3DOP_EXIT:
                        pc = end;
                        continue;

                    case D3DOP_PROCESSVERTICES: {
                        // Records fill DISJOINT ranges of one destination buffer that the next
                        // draw indexes across; only a draw ends the accumulation.
                        beginBlocks();
                        for (let i = 0; i < count; i++) {
                            const rec = body + i * elemSize;
                            const flags = view.getUint32(rec, true);
                            const wStart = view.getUint16(rec + 4, true);
                            const wDest = view.getUint16(rec + 6, true);
                            const vCount = view.getUint32(rec + 8, true);
                            addBlock(wStart, wDest, vCount, fvfForProcessOp(flags & D3DPROCESSVERTICES_OPMASK));
                        }
                        break;
                    }

                    case D3DOP_TRIANGLE:
                    case D3DOP_LINE: {
                        const perElem = opcode === D3DOP_TRIANGLE ? 3 : 2;
                        const packed = count ? packIndices(body, elemSize, count, perElem) : null;
                        if (packed) {
                            drawHandler.handleDrawPrimitive(
                                devicePtr,
                                opcode === D3DOP_TRIANGLE ? D3DPT_TRIANGLELIST : D3DPT_LINELIST,
                                packed.fvf, dstAddr, dstCount, mem, true, packed.addr, count * perElem,
                            );
                        }
                        accumulating = false;
                        break;
                    }

                    case D3DOP_POINT: {
                        // D3DPOINT is a (count, first) run over the destination buffer, not an
                        // index list; wFirst is a raw guest u16 and must land inside a block.
                        for (let i = 0; i < count; i++) {
                            const rec = body + i * elemSize;
                            const wCount = view.getUint16(rec, true);
                            const wFirst = view.getUint16(rec + 2, true);
                            const block = blockFor(wFirst);
                            if (!block || !wCount) continue;
                            const available = block.base + block.count - wFirst;
                            drawHandler.handleDrawPrimitive(
                                devicePtr, D3DPT_POINTLIST, block.fvf,
                                dstAddr + wFirst * VERTEX_STRIDE,
                                Math.min(wCount, available), mem,
                            );
                        }
                        accumulating = false;
                        break;
                    }

                    case D3DOP_STATERENDER:
                    case D3DOP_STATELIGHT:
                    case D3DOP_STATETRANSFORM: {
                        const method = opcode === D3DOP_STATERENDER ? "IDirect3DDevice3_SetRenderState"
                            : opcode === D3DOP_STATELIGHT ? "IDirect3DDevice3_SetLightState"
                                : "IDirect3DDevice3_SetTransform";
                        for (let i = 0; i < count; i++) {
                            const rec = body + i * elemSize;
                            const stateType = view.getUint32(rec, true);
                            const stateValue = view.getUint32(rec + 4, true);
                            Logger.verboseLazy(LogCategory.DDRAW, () =>
                                `[execbuf] ${method.replace("IDirect3DDevice3_", "")}(${stateType}) = 0x${stateValue.toString(16)}`);
                            call(method, ctx, mem, [devicePtr, stateType, stateValue]);
                        }
                        break;
                    }

                    case D3DOP_MATRIXLOAD: {
                        for (let i = 0; i < count; i++) {
                            const rec = body + i * elemSize;
                            const dst = view.getUint32(rec, true);
                            const src = view.getUint32(rec + 4, true);
                            if (dst && src) mem.copyWithin(dst, src, src + MATRIX_BYTES);
                        }
                        break;
                    }

                    case D3DOP_MATRIXMULTIPLY: {
                        for (let i = 0; i < count; i++) {
                            const rec = body + i * elemSize;
                            const dst = view.getUint32(rec, true);
                            const a = view.getUint32(rec + 4, true);
                            const b = view.getUint32(rec + 8, true);
                            if (!dst || !a || !b) continue;
                            const out = new Float32Array(16);
                            for (let r = 0; r < 4; r++) {
                                for (let c = 0; c < 4; c++) {
                                    let sum = 0;
                                    for (let k = 0; k < 4; k++) {
                                        sum += view.getFloat32(a + (r * 4 + k) * 4, true)
                                            * view.getFloat32(b + (k * 4 + c) * 4, true);
                                    }
                                    out[r * 4 + c] = sum;
                                }
                            }
                            for (let k = 0; k < 16; k++) view.setFloat32(dst + k * 4, out[k]!, true);
                        }
                        break;
                    }

                    case D3DOP_TEXTURELOAD: {
                        // Load is a system→video copy the following draws read; when it needs a
                        // GPU round trip it returns a Promise, and dropping that would draw
                        // against the pre-copy texture (and orphan the rejection).
                        const pending = runTextureLoads(body, elemSize, count, 0, ctx, mem);
                        if (pending) return pending.then(() => runFrom(next));
                        break;
                    }

                    case D3DOP_BRANCHFORWARD: {
                        // dwOffset counts from the START of the D3DINSTRUCTION header, and a
                        // zero offset is not a branch at all — the record falls through.
                        if (count) {
                            const mask = view.getUint32(body, true);
                            const value = view.getUint32(body + 4, true);
                            const negate = view.getUint32(body + 8, true) !== 0;
                            const offset = view.getUint32(body + 12, true);
                            const match = (status & mask) === value;
                            if (match !== negate && offset) {
                                const target = pc + offset;
                                if (target <= pc || target > end) {
                                    Logger.warn(LogCategory.DDRAW,
                                        `IDirect3DDevice_Execute: BRANCHFORWARD offset ${offset} at ` +
                                        `0x${pc.toString(16)} leaves the instruction range, stopping`);
                                    pc = end;
                                    continue;
                                }
                                pc = target;
                                continue;
                            }
                        }
                        break;
                    }

                    case D3DOP_SETSTATUS: {
                        for (let i = 0; i < count; i++) {
                            const rec = body + i * elemSize;
                            const flags = view.getUint32(rec, true);
                            // D3DSETSTATUS_STATUS / _EXTENTS select which halves the record carries.
                            if (flags & D3DSETSTATUS_STATUS) status = view.getUint32(rec + 4, true);
                            const d = buf.getExecuteData();
                            d.statusFlags = flags;
                            if (flags & D3DSETSTATUS_STATUS) d.status = status;
                            if (flags & D3DSETSTATUS_EXTENTS) {
                                d.statusExtent = {
                                    left: view.getInt32(rec + 8, true),
                                    top: view.getInt32(rec + 12, true),
                                    right: view.getInt32(rec + 16, true),
                                    bottom: view.getInt32(rec + 20, true),
                                };
                            }
                        }
                        break;
                    }

                    case D3DOP_SPAN:
                        // Span rendering never had hardware behind it; D3D's own HAL ignored it.
                        break;

                    default:
                        // D3D skips a record it does not know and keeps going; the rest of the
                        // buffer is still a valid program. One warning per Execute — a stream
                        // padded with zeros would otherwise log every four bytes.
                        if (!warnedUnknownOpcode) {
                            warnedUnknownOpcode = true;
                            Logger.warn(LogCategory.DDRAW,
                                `IDirect3DDevice_Execute: unknown opcode ${opcode} at 0x${pc.toString(16)}, skipping`);
                        }
                        break;
                }

                pc = next;
            }

            return D3D_OK;
        };

        /** Dispatch TEXTURELOAD records from `startIdx`, suspending on the first async Load. */
        function runTextureLoads(
            body: number, elemSize: number, count: number, startIdx: number,
            ctx: unknown, mem: Uint8Array,
        ): Promise<void> | null {
            for (let i = startIdx; i < count; i++) {
                const rec = body + i * elemSize;
                const result = call("IDirect3DTexture_Load", ctx, mem, [
                    view.getUint32(rec, true),      // hDestTexture
                    view.getUint32(rec + 4, true),  // hSrcTexture
                ]);
                if (isPromise(result)) {
                    return result.then(() => {
                        const rest = runTextureLoads(body, elemSize, count, i + 1, ctx, mem);
                        return rest ?? undefined;
                    });
                }
            }
            return null;
        }

        return runFrom(bufBase + data.instructionOffset);
    };

    // Picking needs a software rasterizer pass no back end of ours runs; report
    // "no records" rather than lie about a hit.
    exports["IDirect3DDevice_Pick"] = () => D3D_OK;
    exports["IDirect3DDevice_GetPickRecords"] = (ctx, mem, args) => {
        const lpCount = args[1];
        if (lpCount && isValidAddress(mem, lpCount, 4, "rw")) {
            new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(lpCount, 0, true);
        }
        return D3D_OK;
    };

    // Viewport enumeration on a v1 device: we keep no per-device viewport list.
    exports["IDirect3DDevice_NextViewport"] = (ctx, mem, args) => {
        const lplpAnotherViewport = args[2];
        if (lplpAnotherViewport && isValidAddress(mem, lplpAnotherViewport, 4, "rw")) {
            new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(lplpAnotherViewport, 0, true);
        }
        return D3D_OK;
    };

    return exports;
};
