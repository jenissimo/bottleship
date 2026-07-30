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
 * index base; D3DOP_TRIANGLE then indexes the DESTINATION space. We keep the
 * source pointer + base and emit one indexed draw per triangle instruction —
 * the same granularity the original driver had.
 */
import { ThunkImplementation } from "../../../core/thunking/thunk-dispatcher";
import { DDrawContext } from "../context";
import { Logger, LogCategory } from "../../../core/logger";
import { ComObjectFactory } from "../../../core/com/base-com-object";
import { Direct3DExecuteBufferObject } from "../com-objects";
import { allocateComObject, IID_IDirect3DExecuteBuffer } from "../constants";
import { createDrawHandler } from "./draw-handler";
import { readGuidFromMem } from "../../../core/com/typelib/typelib-types";

const D3D_OK = 0;
const E_POINTER = 0x80004003;
const E_NOINTERFACE = 0x80004002;
const E_FAIL = 0x80004005;
const D3DERR_INVALIDCALL = 0x8876086c;
const DDERR_ALREADYINITIALIZED = 0x88000005;
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

// D3DPRIMITIVETYPE
const D3DPT_POINTLIST = 1;
const D3DPT_LINELIST = 2;
const D3DPT_TRIANGLELIST = 4;

// Render states + legacy texture-blend modes the interpreter reacts to itself.
const D3DRENDERSTATE_SRCBLEND = 19;
const D3DRENDERSTATE_DESTBLEND = 20;
const D3DRENDERSTATE_TEXTUREMAPBLEND = 21;
const D3DRENDERSTATE_ALPHABLENDENABLE = 27;
const D3DTBLEND_DECALALPHA = 3;
const D3DTBLEND_MODULATEALPHA = 4;
const D3DBLEND_SRCALPHA = 5;
const D3DBLEND_INVSRCALPHA = 6;

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
const D3DEXECUTEBUFFERDESC_SIZE = 20;

/** Where the last PROCESSVERTICES put its output, so triangles can index it. */
interface VertexWindow {
    srcAddr: number;
    base: number;
    count: number;
    fvf: number;
}

export const createExecuteBufferExports = (
    context: DDrawContext,
    drawHandler: ReturnType<typeof createDrawHandler>,
    d3dExports: Record<string, ThunkImplementation>,
): Record<string, ThunkImplementation> => {
    const exports: Record<string, ThunkImplementation> = {};
    const resourceProvider = context.resourceProvider;

    /** Scratch guest buffer for packed 16-bit indices (the opcode stream stores them strided). */
    let indexScratch = 0;
    let indexScratchBytes = 0;
    const ensureIndexScratch = (bytes: number): number => {
        if (indexScratchBytes >= bytes) return indexScratch;
        const memory = context.process.memory;
        if (indexScratch) memory.free(indexScratch);
        const size = Math.max(bytes, 4096);
        indexScratch = memory.alloc(size);
        indexScratchBytes = indexScratch ? size : 0;
        return indexScratch;
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
        if (!obj || !lpDesc) return D3DERR_INVALIDCALL;

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

    exports["IDirect3DExecuteBuffer_SetExecuteData"] = (ctx, mem, args) => {
        const obj = getBuffer(args[0]);
        const lpData = args[1];
        if (!obj || !lpData) return D3DERR_INVALIDCALL;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        obj.setExecuteData({
            vertexOffset: view.getUint32(lpData + 4, true),
            vertexCount: view.getUint32(lpData + 8, true),
            instructionOffset: view.getUint32(lpData + 12, true),
            instructionLength: view.getUint32(lpData + 16, true),
            hVertexOffset: view.getUint32(lpData + 20, true),
        });
        return D3D_OK;
    };

    exports["IDirect3DExecuteBuffer_GetExecuteData"] = (ctx, mem, args) => {
        const obj = getBuffer(args[0]);
        const lpData = args[1];
        if (!obj || !lpData) return D3DERR_INVALIDCALL;
        const d = obj.getExecuteData();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lpData + 4, d.vertexOffset, true);
        view.setUint32(lpData + 8, d.vertexCount, true);
        view.setUint32(lpData + 12, d.instructionOffset, true);
        view.setUint32(lpData + 16, d.instructionLength, true);
        view.setUint32(lpData + 20, d.hVertexOffset, true);
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
    const call = (name: string, ctx: any, mem: Uint8Array, args: number[]): void => {
        const fn = d3dExports[name];
        if (fn) fn(ctx, mem, args);
    };

    /** Pack the strided triangle/line indices into the scratch buffer, rebased to the window. */
    const packIndices = (view: DataView, base: number, stride: number, count: number,
                         perElem: number, window: VertexWindow, mem: Uint8Array): number => {
        const scratch = ensureIndexScratch(count * perElem * 2);
        if (!scratch) return 0;
        const out = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < count; i++) {
            for (let k = 0; k < perElem; k++) {
                const idx = view.getUint16(base + i * stride + k * 2, true) - window.base;
                out.setUint16(scratch + (i * perElem + k) * 2, Math.max(0, idx), true);
            }
        }
        return scratch;
    };

    exports["IDirect3DDevice_Execute"] = (ctx, mem, args) => {
        const devicePtr = args[0];
        const bufferPtr = args[1];
        const viewportPtr = args[2];

        const buf = getBuffer(bufferPtr);
        if (!buf) return D3DERR_INVALIDCALL;
        const data = buf.getExecuteData();
        const bufBase = buf.getDataAddr();
        if (!bufBase || !data.instructionLength) return D3D_OK;

        // Execute takes the viewport per call; the draw path reads it off the device.
        if (viewportPtr) call("IDirect3DDevice3_SetCurrentViewport", ctx, mem, [devicePtr, viewportPtr]);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let pc = bufBase + data.instructionOffset;
        const end = pc + data.instructionLength;
        // Vertices default to the buffer's own block until PROCESSVERTICES says otherwise.
        let window: VertexWindow = {
            srcAddr: bufBase + data.vertexOffset,
            base: 0,
            count: data.vertexCount,
            fvf: D3DFVF_TLVERTEX,
        };
        let status = 0;

        while (pc + 4 <= end) {
            const opcode = view.getUint8(pc);
            const elemSize = view.getUint8(pc + 1);
            const count = view.getUint16(pc + 2, true);
            const body = pc + 4;
            const next = body + elemSize * count;

            switch (opcode) {
                case D3DOP_EXIT:
                    pc = end;
                    continue;

                case D3DOP_PROCESSVERTICES: {
                    // Only the last block before a draw matters — triangles index its output.
                    for (let i = 0; i < count; i++) {
                        const rec = body + i * elemSize;
                        const flags = view.getUint32(rec, true);
                        const wStart = view.getUint16(rec + 4, true);
                        const wDest = view.getUint16(rec + 6, true);
                        const vCount = view.getUint32(rec + 8, true);
                        const op = flags & D3DPROCESSVERTICES_OPMASK;
                        window = {
                            srcAddr: bufBase + data.vertexOffset + wStart * VERTEX_STRIDE,
                            base: wDest,
                            count: vCount,
                            fvf: fvfForProcessOp(op),
                        };
                    }
                    break;
                }

                case D3DOP_TRIANGLE: {
                    const indices = packIndices(view, body, elemSize, count, 3, window, mem);
                    if (indices) {
                        drawHandler.handleDrawPrimitive(
                            devicePtr, D3DPT_TRIANGLELIST, window.fvf, window.srcAddr,
                            window.count, mem, true, indices, count * 3,
                        );
                    }
                    break;
                }

                case D3DOP_LINE: {
                    const indices = packIndices(view, body, elemSize, count, 2, window, mem);
                    if (indices) {
                        drawHandler.handleDrawPrimitive(
                            devicePtr, D3DPT_LINELIST, window.fvf, window.srcAddr,
                            window.count, mem, true, indices, count * 2,
                        );
                    }
                    break;
                }

                case D3DOP_POINT: {
                    // D3DPOINT is a (count, first) run over the window, not an index list.
                    for (let i = 0; i < count; i++) {
                        const rec = body + i * elemSize;
                        const wCount = view.getUint16(rec, true);
                        const wFirst = view.getUint16(rec + 2, true);
                        drawHandler.handleDrawPrimitive(
                            devicePtr, D3DPT_POINTLIST, window.fvf,
                            window.srcAddr + (wFirst - window.base) * VERTEX_STRIDE,
                            wCount, mem,
                        );
                    }
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
                    for (let i = 0; i < count; i++) {
                        const rec = body + i * elemSize;
                        call("IDirect3DTexture_Load", ctx, mem, [
                            view.getUint32(rec, true),      // hDestTexture
                            view.getUint32(rec + 4, true),  // hSrcTexture
                        ]);
                    }
                    break;
                }

                case D3DOP_BRANCHFORWARD: {
                    // One branch record per instruction in practice; honour the first.
                    if (count) {
                        const mask = view.getUint32(body, true);
                        const value = view.getUint32(body + 4, true);
                        const negate = view.getUint32(body + 8, true) !== 0;
                        const offset = view.getUint32(body + 12, true);
                        const match = (status & mask) === value;
                        if (match !== negate) {
                            if (!offset) { pc = end; continue; }
                            pc = next + offset;
                            continue;
                        }
                    }
                    break;
                }

                case D3DOP_SETSTATUS: {
                    if (count) status = view.getUint32(body + 4, true); // dwStatus
                    break;
                }

                case D3DOP_SPAN:
                    // Span rendering never had hardware behind it; D3D's own HAL ignored it.
                    break;

                default:
                    Logger.warn(LogCategory.DDRAW,
                        `IDirect3DDevice_Execute: unknown opcode ${opcode} at 0x${pc.toString(16)}, stopping`);
                    pc = end;
                    continue;
            }

            pc = next;
        }

        return D3D_OK;
    };

    // Picking needs a software rasterizer pass no back end of ours runs; report
    // "no records" rather than lie about a hit.
    exports["IDirect3DDevice_Pick"] = () => D3D_OK;
    exports["IDirect3DDevice_GetPickRecords"] = (ctx, mem, args) => {
        const lpCount = args[1];
        if (lpCount) new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(lpCount, 0, true);
        return D3D_OK;
    };

    // Viewport enumeration on a v1 device: we keep no per-device viewport list.
    exports["IDirect3DDevice_NextViewport"] = (ctx, mem, args) => {
        const lplpAnotherViewport = args[2];
        if (lplpAnotherViewport) {
            new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(lplpAnotherViewport, 0, true);
        }
        return D3D_OK;
    };

    return exports;
};

/** Size of D3DEXECUTEBUFFERDESC, exported for callers validating the guest struct. */
export const EXECUTE_BUFFER_DESC_SIZE = D3DEXECUTEBUFFERDESC_SIZE;
