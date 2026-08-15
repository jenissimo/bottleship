/**
 * D3D8 FastPath registrations (Phase 1 of the D3D9-parity setter treatment).
 *
 * Max Payne (and every in-game D3D8 title) drives the pipeline through D3D8 state
 * setters at ~240K calls/sec. Unlike the DDraw/D3D7 path (registerFastPathD3DFunctions,
 * ddraw/d3d/index.ts) and the D3D9 backend (registerFastPathD3D9Functions), the D3D8
 * backend had ZERO fast-path/WBUF registrations — so EVERY setter fell into the OUT-trap
 * slow path (_handlePortWriteSlow: module-base lookup on the return addr, ESP/EBP sanity,
 * WinAPI ring record, polling detector, virtual-time credit). A live profile of Max Payne
 * showed ~15% of worker self-time in _handlePortWriteSlow, ~85% of it D3D8 setters.
 *
 * These FastPath handlers read the args straight off the guest stack (esp+4+4*i, stdcall/
 * thiscall: this=arg0) and apply them, bypassing the slow-path prologue. They mirror the
 * thunk bodies in state.ts / device.ts EXACTLY — including the BeginStateBlock recording
 * branch (record-without-apply, real D3D8 semantics) — minus the eager diagnostic logging.
 * A handler that hits a bad pointer / missing device returns null to fall through to the
 * slow thunk (which keeps the full diagnostics).
 *
 * Phase 2 (follow-up) layers Tier-0 WBUF trampolines on top to kill the OUT trap itself,
 * mirroring d3d9/fast-path.ts; this file stays as the ring-overflow fallback for that.
 */

import { Logger, LogCategory } from '../../core/logger';
import { sanitizeViewport } from '../../backends/webgpu/ddraw/types';
import { devices, resourceToDevice } from './shared-state';
import { validateLockRange } from './resources';
import { readD3DLight8 } from './state';
import { D3D8_MAX_STREAMS } from '../../backends/webgpu/d3d8/vsd-constants';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DLIGHT8_SIZE = 104;

export function registerFastPathD3D8Functions(dispatcher: any): void {
    if (!dispatcher || typeof dispatcher.registerFastPath !== 'function') return;

    // IDirect3DDevice8_SetRenderState(this, State, Value)
    dispatcher.registerFastPath('d3d8', 'IDirect3DDevice8_SetRenderState',
        (cpu: any, _mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const device = devices.get(view.getUint32(esp + 4, true));
            if (!device) return D3DERR_INVALIDCALL;
            const state = view.getUint32(esp + 8, true), value = view.getUint32(esp + 12, true);
            if (device.recordingStateBlock) { device.recordStateBlock({ op: 'renderState', state, value }); return D3D_OK; }
            device.setRenderState(state, value);
            return D3D_OK;
        }, { trivial: true });

    // IDirect3DDevice8_SetTextureStageState(this, Stage, Type, Value)
    dispatcher.registerFastPath('d3d8', 'IDirect3DDevice8_SetTextureStageState',
        (cpu: any, _mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const device = devices.get(view.getUint32(esp + 4, true));
            if (!device) return D3DERR_INVALIDCALL;
            const stage = view.getUint32(esp + 8, true), type = view.getUint32(esp + 12, true), value = view.getUint32(esp + 16, true);
            if (device.recordingStateBlock) { device.recordStateBlock({ op: 'textureStageState', stage, type, value }); return D3D_OK; }
            device.setTextureStageState(stage, type, value);
            return D3D_OK;
        }, { trivial: true });

    // IDirect3DDevice8_SetTexture(this, Stage, pTexture) — resolve COM ptr → surface at call time.
    dispatcher.registerFastPath('d3d8', 'IDirect3DDevice8_SetTexture',
        (cpu: any, _mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const device = devices.get(view.getUint32(esp + 4, true));
            if (!device) return D3DERR_INVALIDCALL;
            const stage = view.getUint32(esp + 8, true), texPtr = view.getUint32(esp + 12, true);
            if (device.recordingStateBlock) { device.recordStateBlock({ op: 'texture', stage, texPtr: texPtr >>> 0 }); return D3D_OK; }
            if (texPtr === 0) { device.setTexture(stage, null, 0); return D3D_OK; }
            device.setTexture(stage, device.texSurfaces.get(texPtr) ?? null, texPtr);
            return D3D_OK;
        }, { trivial: true });

    // IDirect3DDevice8_LightEnable(this, Index, Enable)
    dispatcher.registerFastPath('d3d8', 'IDirect3DDevice8_LightEnable',
        (cpu: any, _mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const device = devices.get(view.getUint32(esp + 4, true));
            if (!device) return D3DERR_INVALIDCALL;
            const index = view.getUint32(esp + 8, true), enable = view.getUint32(esp + 12, true) !== 0;
            if (device.recordingStateBlock) { device.recordStateBlock({ op: 'lightEnable', index, enable }); return D3D_OK; }
            device.lightEnable(index, enable);
            return D3D_OK;
        }, { trivial: true });

    // IDirect3DDevice8_SetTransform(this, State, pMatrix[16 floats]) — capture-at-call
    // (pMatrix is guest scratch; copy the 16 floats out now).
    dispatcher.registerFastPath('d3d8', 'IDirect3DDevice8_SetTransform',
        (cpu: any, mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const device = devices.get(view.getUint32(esp + 4, true));
            if (!device) return D3DERR_INVALIDCALL;
            const state = view.getUint32(esp + 8, true), pMatrix = view.getUint32(esp + 12, true) >>> 0;
            if (!pMatrix || pMatrix + 64 > mem.length) return null; // bad ptr → slow thunk
            const matrix = new Float32Array(16);
            for (let i = 0; i < 16; i++) matrix[i] = view.getFloat32(pMatrix + i * 4, true);
            if (device.recordingStateBlock) { device.recordStateBlock({ op: 'transform', state, matrix }); return D3D_OK; }
            device.setTransform(state, matrix);
            return D3D_OK;
        }, { trivial: true });

    // IDirect3DDevice8_SetStreamSource(this, StreamNumber, pStreamData, Stride) — D3D8 has NO OffsetInBytes.
    dispatcher.registerFastPath('d3d8', 'IDirect3DDevice8_SetStreamSource',
        (cpu: any, _mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const device = devices.get(view.getUint32(esp + 4, true));
            if (!device) return D3DERR_INVALIDCALL;
            const streamNumber = view.getUint32(esp + 8, true) >>> 0;
            const vbPtr = view.getUint32(esp + 12, true) >>> 0;
            const stride = view.getUint32(esp + 16, true) >>> 0;
            if (streamNumber >= D3D8_MAX_STREAMS) {
                Logger.warn(LogCategory.SYSTEM, `D3D8 SetStreamSource: stream ${streamNumber} exceeds MaxStreams`);
                return D3DERR_INVALIDCALL;
            }
            if (vbPtr !== 0 && !device.vbData.has(vbPtr)) return null; // unknown VB → slow thunk (warns)
            if (device.recordingStateBlock) { device.recordStateBlock({ op: 'streamSource', stream: streamNumber, vb: vbPtr, stride }); return D3D_OK; }
            device.setStreamSource(streamNumber, vbPtr, stride);
            return D3D_OK;
        }, { trivial: true });

    // IDirect3DDevice8_SetIndices(this, pIndexData, BaseVertexIndex) — D3D8 folds BaseVertexIndex here.
    dispatcher.registerFastPath('d3d8', 'IDirect3DDevice8_SetIndices',
        (cpu: any, _mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const device = devices.get(view.getUint32(esp + 4, true));
            if (!device) return D3DERR_INVALIDCALL;
            const ibPtr = view.getUint32(esp + 8, true) >>> 0;
            const baseVertex = view.getInt32(esp + 12, true);
            if (ibPtr !== 0 && !device.ibData.has(ibPtr)) return null; // unknown IB → slow thunk (warns)
            if (device.recordingStateBlock) { device.recordStateBlock({ op: 'indices', ib: ibPtr, baseVertex }); return D3D_OK; }
            device.indexIB = ibPtr;
            device.baseVertexIndex = baseVertex;
            return D3D_OK;
        }, { trivial: true });

    // IDirect3DDevice8_SetVertexShader(this, Handle) — D3D8 quirk: FVF token (bit0 clear) or shader handle (bit0 set).
    dispatcher.registerFastPath('d3d8', 'IDirect3DDevice8_SetVertexShader',
        (cpu: any, _mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const device = devices.get(view.getUint32(esp + 4, true));
            if (!device) return D3DERR_INVALIDCALL;
            const token = view.getUint32(esp + 8, true) >>> 0;
            if (device.recordingStateBlock) {
                if ((token & 0x1) !== 0 && !device.shaders.getVsObject(token)) return D3DERR_INVALIDCALL;
                device.recordStateBlock({ op: 'vertexShader', token });
                return D3D_OK;
            }
            if ((token & 0x1) === 0) { device.setFVF(token); return D3D_OK; }
            return device.setVertexShaderHandle(token);
        }, { trivial: true });

    // IDirect3DDevice8_SetViewport(this, pViewport) — capture-at-call (sanitize vs active RT).
    dispatcher.registerFastPath('d3d8', 'IDirect3DDevice8_SetViewport',
        (cpu: any, mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const device = devices.get(view.getUint32(esp + 4, true));
            if (!device) return D3DERR_INVALIDCALL;
            const pVP = view.getUint32(esp + 8, true) >>> 0;
            if (!pVP || pVP + 24 > mem.length) return null; // bad ptr → slow thunk
            const rt = device.activeRenderTarget;
            const vp = sanitizeViewport({
                x: view.getUint32(pVP + 0, true),
                y: view.getUint32(pVP + 4, true),
                width: view.getUint32(pVP + 8, true),
                height: view.getUint32(pVP + 12, true),
                minZ: view.getFloat32(pVP + 16, true),
                maxZ: view.getFloat32(pVP + 20, true),
            }, rt.width, rt.height);
            if (device.recordingStateBlock) { device.recordStateBlock({ op: 'viewport', vp }); return D3D_OK; }
            device.viewport = vp;
            return D3D_OK;
        }, { trivial: true });

    // ── Draws on the FastPath (kill the slow-path prologue; ring/barrier comes in Phase 2) ──
    // IDirect3DDevice8_DrawPrimitive(this, PrimitiveType, StartVertex, PrimitiveCount)
    dispatcher.registerFastPath('d3d8', 'IDirect3DDevice8_DrawPrimitive',
        (cpu: any, _mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const device = devices.get(view.getUint32(esp + 4, true));
            if (!device) return D3DERR_INVALIDCALL;
            return device.drawPrimitive(view.getUint32(esp + 8, true), view.getUint32(esp + 12, true), view.getUint32(esp + 16, true));
        });

    // IDirect3DDevice8_DrawIndexedPrimitive(this, PrimType, MinIndex, NumVertices, StartIndex, PrimCount)
    dispatcher.registerFastPath('d3d8', 'IDirect3DDevice8_DrawIndexedPrimitive',
        (cpu: any, _mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const device = devices.get(view.getUint32(esp + 4, true));
            if (!device) return D3DERR_INVALIDCALL;
            return device.drawIndexedPrimitive(
                view.getUint32(esp + 8, true), view.getUint32(esp + 12, true), view.getUint32(esp + 16, true),
                view.getUint32(esp + 20, true), view.getUint32(esp + 24, true));
        });

    // ── per-DRAW buffer traffic ────────────────────────────────────────────────
    // Lock/Unlock of a VB/IB is a per-draw call on every FVF title; both Unlocks are
    // literally `return D3D_OK` thunks that were still paying the whole OUT-trap prologue.
    // These are FastPath-only (no WBUF): Lock has an out-param the guest reads immediately.

    // IDirect3DVertexBuffer8_Lock(this, Offset, Size, ppData, Flags)
    dispatcher.registerFastPath('d3d8', 'IDirect3DVertexBuffer8_Lock',
        (cpu: any, mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const pVB = view.getUint32(esp + 4, true);
            const offset = view.getUint32(esp + 8, true);
            const size = view.getUint32(esp + 12, true);
            const ppData = view.getUint32(esp + 16, true) >>> 0;
            const device = resourceToDevice.get(pVB);
            if (!device) return D3DERR_INVALIDCALL;
            if (!ppData) return D3DERR_INVALIDCALL;
            const vb = device.vbData.get(pVB);
            if (!vb) return D3DERR_INVALIDCALL;
            // Out of range, or an out-param we would have to validate against the region
            // map, falls through to the slow thunk — it owns Mem.writeUint32 and the
            // diagnostic. A raw view write past the end of guest memory would throw.
            if (validateLockRange(vb.size, offset, size) === null) return null;
            if (ppData + 4 > mem.length) return null;
            view.setUint32(ppData, (vb.guestPtr + offset) >>> 0, true);
            return D3D_OK;
        }, { trivial: true });

    // IDirect3DIndexBuffer8_Lock(this, Offset, Size, ppData, Flags)
    dispatcher.registerFastPath('d3d8', 'IDirect3DIndexBuffer8_Lock',
        (cpu: any, mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const pIB = view.getUint32(esp + 4, true);
            const offset = view.getUint32(esp + 8, true);
            const size = view.getUint32(esp + 12, true);
            const ppData = view.getUint32(esp + 16, true) >>> 0;
            const device = resourceToDevice.get(pIB);
            if (!device) return D3DERR_INVALIDCALL;
            if (!ppData) return D3DERR_INVALIDCALL;
            const ib = device.ibData.get(pIB);
            if (!ib) return D3DERR_INVALIDCALL;
            if (validateLockRange(ib.size, offset, size) === null) return null;
            if (ppData + 4 > mem.length) return null;
            view.setUint32(ppData, (ib.guestPtr + offset) >>> 0, true);
            return D3D_OK;
        }, { trivial: true });

    // Both Unlocks are no-ops in this implementation (the guest wrote straight into the
    // buffer's own guest memory), so the fast path IS the whole contract.
    dispatcher.registerFastPath('d3d8', 'IDirect3DVertexBuffer8_Unlock',
        (): number | null => D3D_OK, { trivial: true });
    dispatcher.registerFastPath('d3d8', 'IDirect3DIndexBuffer8_Unlock',
        (): number | null => D3D_OK, { trivial: true });

    // IDirect3DDevice8_SetLight(this, Index, pLight) — reads the guest D3DLIGHT8 through
    // the same reader the thunk uses (state.ts readD3DLight8), so the two cannot drift.
    dispatcher.registerFastPath('d3d8', 'IDirect3DDevice8_SetLight',
        (cpu: any, mem: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const device = devices.get(view.getUint32(esp + 4, true));
            if (!device) return D3DERR_INVALIDCALL;
            const index = view.getUint32(esp + 8, true);
            const pLight = view.getUint32(esp + 12, true) >>> 0;
            if (!pLight) return D3DERR_INVALIDCALL;
            if (pLight + D3DLIGHT8_SIZE > mem.length) return null; // bad ptr → slow thunk
            const light = readD3DLight8(view, pLight);
            if (device.recordingStateBlock) { device.recordStateBlock({ op: 'light', index, light }); return D3D_OK; }
            device.setLight(index, light);
            return D3D_OK;
        }, { trivial: true });

    // =========================================================================
    // Phase 2 — Tier-0 write-buffer (WBUF) trampolines. The OUT-trap stub is patched
    // to a JMP trampoline that writes [funcId, args…] to a ring in THUNK_DATA; the ring
    // is drained at the START of every OUT trap (handlePortWrite → drainWriteBuffer), so
    // all buffered state is applied before any trapped call (Present/BeginScene/Lock/…)
    // or buffered draw observes it. This kills the per-setter OUT trap entirely — the
    // setters run as JIT'd guest trampolines, and JS only runs once per drain.
    //
    // Recording (BeginStateBlock) is correct because the drain handlers call the SAME
    // device methods as the thunk/FastPath, and recording now lives INSIDE those device
    // methods (d3d8-device-adapter.ts) — the WBUF drain journals without applying while a
    // block records. Begin/EndStateBlock are themselves OUT traps that drain first, so a
    // setter buffered during recording is journaled before EndStateBlock closes the block.
    //
    // WBUF-safe setters take scalar or STABLE-pointer args (VB/IB/texture COM ptrs): the
    // deref-at-drain reads the same value a call-time deref would. SetTransform passes a
    // scratch pointer the guest may reuse before drain, so it rides a struct-capture
    // trampoline that copies the 16 matrix floats INTO the ring at call time.
    //
    // Kill-switch (A/B, boot-time): globalThis.__noD3D8Wbuf. FastPath handlers above stay
    // registered as the ring-overflow / bad-pointer fallback.
    // =========================================================================
    if (typeof dispatcher.registerWriteBufferFunction !== 'function' || (globalThis as any).__noD3D8Wbuf) {
        Logger.log(LogCategory.SYSTEM, '[D3D8] Registered fast paths for hot device setters + draws (WBUF off)');
        return;
    }

    // SetRenderState (3 args) — coalesce slot = (this, State).
    dispatcher.registerWriteBufferFunction('d3d8', 'IDirect3DDevice8_SetRenderState', 3,
        (_m8: Uint8Array, m32: Uint32Array, ptr: number) => {
            const d = devices.get(m32[ptr >> 2]);
            if (d) d.setRenderState(m32[(ptr + 4) >> 2], m32[(ptr + 8) >> 2]);
        }, true, 0x3);

    // SetTextureStageState (4 args) — coalesce slot = (this, Stage, Type).
    dispatcher.registerWriteBufferFunction('d3d8', 'IDirect3DDevice8_SetTextureStageState', 4,
        (_m8: Uint8Array, m32: Uint32Array, ptr: number) => {
            const d = devices.get(m32[ptr >> 2]);
            if (d) d.setTextureStageState(m32[(ptr + 4) >> 2], m32[(ptr + 8) >> 2], m32[(ptr + 12) >> 2]);
        }, true, 0x7);

    // SetTexture (3 args) — stable COM ptr; resolve → surface at drain. Slot = (this, Stage).
    dispatcher.registerWriteBufferFunction('d3d8', 'IDirect3DDevice8_SetTexture', 3,
        (_m8: Uint8Array, m32: Uint32Array, ptr: number) => {
            const d = devices.get(m32[ptr >> 2]);
            if (!d) return;
            const stage = m32[(ptr + 4) >> 2], texPtr = m32[(ptr + 8) >> 2] >>> 0;
            if (texPtr === 0) { d.setTexture(stage, null, 0); return; }
            d.setTexture(stage, d.texSurfaces.get(texPtr) ?? null, texPtr);
        }, true, 0x3);

    // LightEnable (3 args) — coalesce slot = (this, Index).
    dispatcher.registerWriteBufferFunction('d3d8', 'IDirect3DDevice8_LightEnable', 3,
        (_m8: Uint8Array, m32: Uint32Array, ptr: number) => {
            const d = devices.get(m32[ptr >> 2]);
            if (d) d.lightEnable(m32[(ptr + 4) >> 2], m32[(ptr + 8) >> 2] !== 0);
        }, true, 0x3);

    // SetStreamSource (4 args: this, Stream, pVB, Stride — D3D8 has NO Offset). Slot = (this, Stream).
    dispatcher.registerWriteBufferFunction('d3d8', 'IDirect3DDevice8_SetStreamSource', 4,
        (_m8: Uint8Array, m32: Uint32Array, ptr: number) => {
            const d = devices.get(m32[ptr >> 2]);
            if (d) d.setStreamSource(m32[(ptr + 4) >> 2] >>> 0, m32[(ptr + 8) >> 2] >>> 0, m32[(ptr + 12) >> 2] >>> 0);
        }, true, 0x3);

    // SetIndices (3 args: this, pIB, BaseVertexIndex). Slot = (this) — last binding wins.
    dispatcher.registerWriteBufferFunction('d3d8', 'IDirect3DDevice8_SetIndices', 3,
        (_m8: Uint8Array, m32: Uint32Array, ptr: number) => {
            const d = devices.get(m32[ptr >> 2]);
            if (d) d.setIndices(m32[(ptr + 4) >> 2] >>> 0, m32[(ptr + 8) >> 2] | 0);
        }, true, 0x1);

    // ── Draws on the ring (barrier: observes buffered state, blocks cross-draw coalescing) ──
    // DrawPrimitive(this, PrimitiveType, StartVertex, PrimitiveCount)
    dispatcher.registerWriteBufferFunction('d3d8', 'IDirect3DDevice8_DrawPrimitive', 4,
        (_m8: Uint8Array, m32: Uint32Array, ptr: number) => {
            const d = devices.get(m32[ptr >> 2]);
            if (d) d.drawPrimitive(m32[(ptr + 4) >> 2], m32[(ptr + 8) >> 2], m32[(ptr + 12) >> 2]);
        }, true, 0, { barrier: true });

    // DrawIndexedPrimitive(this, PrimType, MinIndex, NumVertices, StartIndex, PrimCount)
    dispatcher.registerWriteBufferFunction('d3d8', 'IDirect3DDevice8_DrawIndexedPrimitive', 6,
        (_m8: Uint8Array, m32: Uint32Array, ptr: number) => {
            const d = devices.get(m32[ptr >> 2]);
            if (d) d.drawIndexedPrimitive(
                m32[(ptr + 4) >> 2], m32[(ptr + 8) >> 2], m32[(ptr + 12) >> 2],
                m32[(ptr + 16) >> 2], m32[(ptr + 20) >> 2]);
        }, true, 0, { barrier: true });

    // SetTransform (this, State, pMatrix[16 floats]) — capture-at-call (pMatrix is guest
    // scratch). Ring layout: this@+0, State@+4, pMatrix-ptr@+8, payload floats@+12.
    if (typeof dispatcher.registerStructCaptureWriteBufferFunction === 'function') {
        dispatcher.registerStructCaptureWriteBufferFunction('d3d8', 'IDirect3DDevice8_SetTransform', 3, 2, 16,
            (_m8: Uint8Array, m32: Uint32Array, ptr: number) => {
                const d = devices.get(m32[ptr >> 2]);
                if (!d) return;
                const f = new Float32Array(16);
                const u = new Uint32Array(f.buffer);
                const w = (ptr + 12) >> 2;
                for (let i = 0; i < 16; i++) u[i] = m32[w + i];
                d.setTransform(m32[(ptr + 4) >> 2], f);
            });
    }

    Logger.log(LogCategory.SYSTEM, '[D3D8] Registered fast paths + Tier-0 WBUF for hot device setters + draws');
}
