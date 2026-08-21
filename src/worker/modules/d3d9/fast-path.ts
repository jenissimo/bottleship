/**
 * D3D9 FastPath + Tier-0 Write-Buffer registrations
 *
 * NFSU (and every in-game D3D9 title) drives the pipeline through D3D9 state
 * setters at 100K+ calls/sec. Unlike the DDraw/D3D7 path — which had 24
 * fast-path/WBUF registrations — the D3D9 backend had ZERO, so every setter fell
 * into the OUT-trap slow path (_handlePortWriteSlow + per-thunk shadow-stack
 * guard, virtual-time credit, DataView validation, winapi ring). A profile of
 * NFSU in-game showed ~28% of worker time in _handlePortWriteSlow, all of it
 * D3D9 setters.
 *
 * This mirrors registerFastPathD3DFunctions (ddraw/d3d/index.ts):
 *   - Tier-0 write-buffer (WBUF): the OUT-trap stub is patched to a JMP
 *     trampoline that writes [funcId, args…] to a ring in THUNK_DATA. The ring
 *     is drained at the start of EVERY OUT trap (handlePortWrite → drainWriteBuffer),
 *     so all buffered state is applied before any trapped call — DrawPrimitive,
 *     Begin/EndScene, Present, Begin/EndStateBlock — observes it. This drain-at-
 *     every-trap property is what makes WBUF ordering safe (incl. state-block
 *     capture: Begin/EndStateBlock are themselves traps that drain first).
 *   - FastPath: same handler reachable via the OUT trap (ring-overflow fallback,
 *     and the only path for setters whose payload must be captured at call time).
 *
 * WBUF-safe setters take scalar or STABLE-pointer args (COM ptrs, VB/IB ptrs):
 * deref-at-drain reads the same value the call-time deref would. Shader-constant
 * setters use a dedicated WBUF trampoline that copies float bits inline at call
 * time (guest may reuse pConstantData before drain); FastPath remains the ring-
 * overflow fallback.
 */

import { Logger, LogCategory } from '../../core/logger';
import { devices, stateBlocks, resourceToDevice } from './shared-state';
import { addD3D9ComRef, releaseD3D9ComRef } from './state';
import {
    resolveVertexShaderComPtr,
    resolvePixelShaderComPtr,
    resolveVertexDeclComPtr,
} from '../../backends/webgpu/d3d9/d3d9-com-objects';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DMATRIX_SIZE = 16 * 4;
const D3DMATERIAL9_SIZE = 68;
const D3DLIGHT9_SIZE = 104;
const D3DCLIPPLANE_SIZE = 4 * 4;

function validGuestRange(mem: Uint8Array, ptr: number, size: number): boolean {
    return ptr !== 0 && size >= 0 && ptr <= mem.length - size;
}

export function registerFastPathD3D9Functions(dispatcher: any): void {
    if (!dispatcher || typeof dispatcher.registerFastPath !== 'function') {
        return;
    }

    // ========================================================================
    // FastPath registrations (OUT-trap path: ring-overflow fallback + the only
    // path for the capture-at-call shader-constant setters).
    // devices.get() is a single-entry Map lookup — cheap enough to skip caching,
    // and caching would risk returning a torn-down device after a game switch
    // (resetD3D9SharedState clears the map; a reused ptr would alias the stale obj).
    // ========================================================================

    // IDirect3DDevice9_SetRenderState(thisPtr, State, Value)
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetRenderState', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (device) device.setRenderState(view.getUint32(esp + 8, true), view.getUint32(esp + 12, true));
        return D3D_OK;
    }, { trivial: true });

    // IDirect3DDevice9_SetTransform(thisPtr, State, pMatrix)
    // CAPTURE-AT-CALL (not WBUF): pMatrix is guest scratch memory and may be reused
    // before the next OUT trap drains the write-buffer.
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetTransform', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (!device) return D3DERR_INVALIDCALL;
        const pMatrix = view.getUint32(esp + 12, true);
        if (!validGuestRange(mem, pMatrix, D3DMATRIX_SIZE)) return D3DERR_INVALIDCALL;
        const matrix = new Float32Array(16);
        for (let i = 0; i < 16; i++) {
            matrix[i] = view.getFloat32(pMatrix + i * 4, true);
        }
        return device.setTransform(view.getUint32(esp + 8, true), matrix);
    }, { trivial: true });

    // IDirect3DDevice9_SetFVF(thisPtr, FVF)
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetFVF', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (!device) return D3DERR_INVALIDCALL;
        return device.setFVF(view.getUint32(esp + 8, true));
    }, { trivial: true });

    // IDirect3DDevice9_SetSamplerState(thisPtr, Sampler, Type, Value)
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetSamplerState', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (device) device.setSamplerState(view.getUint32(esp + 8, true), view.getUint32(esp + 12, true), view.getUint32(esp + 16, true));
        return D3D_OK;
    }, { trivial: true });

    // IDirect3DDevice9_SetTexture(thisPtr, Stage, pTexture)
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetTexture', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (!device) return D3DERR_INVALIDCALL;
        return device.setTexture(view.getUint32(esp + 8, true), view.getUint32(esp + 12, true));
    }, { trivial: true });

    // IDirect3DDevice9_SetStreamSource(thisPtr, StreamNumber, pStreamData, OffsetInBytes, Stride)
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetStreamSource', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (!device) return D3DERR_INVALIDCALL;
        return device.setStreamSource(view.getUint32(esp + 8, true), view.getUint32(esp + 12, true), view.getUint32(esp + 16, true), view.getUint32(esp + 20, true));
    }, { trivial: true });

    // IDirect3DDevice9_SetIndices(thisPtr, pIndexData)
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetIndices', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (!device) return D3DERR_INVALIDCALL;
        return device.setIndices(view.getUint32(esp + 8, true));
    }, { trivial: true });

    // IDirect3DDevice9_SetVertexShader(thisPtr, pShader) — resolve COM ptr → internal handle.
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetVertexShader', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (!device) return D3D_OK;
        const pShader = view.getUint32(esp + 8, true);
        if (pShader === 0) { device.setVertexShader(0, 0); return D3D_OK; }
        const meta = resolveVertexShaderComPtr(pShader);
        if (meta) device.setVertexShader(meta.internalHandle, pShader);
        return D3D_OK;
    }, { trivial: true });

    // IDirect3DDevice9_SetPixelShader(thisPtr, pShader)
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetPixelShader', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (!device) return D3D_OK;
        const pShader = view.getUint32(esp + 8, true);
        if (pShader === 0) { device.setPixelShader(0, 0); return D3D_OK; }
        const meta = resolvePixelShaderComPtr(pShader);
        if (meta) device.setPixelShader(meta.internalHandle, pShader);
        return D3D_OK;
    }, { trivial: true });

    // IDirect3DDevice9_SetVertexShaderConstantF(thisPtr, StartRegister, pConstantData, Vector4fCount)
    // WBUF trampoline captures float bits at call time; FastPath is ring-overflow fallback.
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetVertexShaderConstantF', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (device) device.setVertexShaderConstantF(view.getUint32(esp + 8, true), view.getUint32(esp + 12, true), view.getUint32(esp + 16, true), mem);
        return D3D_OK;
    }, { trivial: true });

    // IDirect3DDevice9_SetPixelShaderConstantF(thisPtr, StartRegister, pConstantData, Vector4fCount)
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetPixelShaderConstantF', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (device) device.setPixelShaderConstantF(view.getUint32(esp + 8, true), view.getUint32(esp + 12, true), view.getUint32(esp + 16, true), mem);
        return D3D_OK;
    }, { trivial: true });

    // IDirect3DDevice9_SetTextureStageState(thisPtr, Stage, Type, Value) — pure FFP
    // texture-stage setter, scalar args. NFSU menu: ~38K/interval, previously all on
    // the slow path. Trivial like SetSamplerState.
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetTextureStageState', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (device) device.setTextureStageState(view.getUint32(esp + 8, true), view.getUint32(esp + 12, true), view.getUint32(esp + 16, true));
        return D3D_OK;
    }, { trivial: true });

    // IDirect3DDevice9_SetMaterial(thisPtr, pMaterial)
    // CAPTURE-AT-CALL (not WBUF): D3DMATERIAL9 is passed by pointer.
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetMaterial', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (!device) return D3DERR_INVALIDCALL;
        const pMaterial = view.getUint32(esp + 8, true);
        if (!validGuestRange(mem, pMaterial, D3DMATERIAL9_SIZE)) return D3DERR_INVALIDCALL;
        return device.setMaterial(mem.subarray(pMaterial, pMaterial + D3DMATERIAL9_SIZE));
    }, { trivial: true });

    // IDirect3DDevice9_SetLight(thisPtr, Index, pLight)
    // CAPTURE-AT-CALL (not WBUF): D3DLIGHT9 is passed by pointer.
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetLight', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (!device) return D3DERR_INVALIDCALL;
        const pLight = view.getUint32(esp + 12, true);
        if (!validGuestRange(mem, pLight, D3DLIGHT9_SIZE)) return D3DERR_INVALIDCALL;
        return device.setLight(view.getUint32(esp + 8, true), mem.subarray(pLight, pLight + D3DLIGHT9_SIZE));
    }, { trivial: true });

    // IDirect3DDevice9_LightEnable(thisPtr, Index, Enable)
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_LightEnable', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (!device) return D3DERR_INVALIDCALL;
        return device.lightEnable(view.getUint32(esp + 8, true), view.getUint32(esp + 12, true));
    }, { trivial: true });

    // IDirect3DDevice9_SetViewport(thisPtr, pViewport)
    // CAPTURE-AT-CALL (not WBUF): D3DVIEWPORT9 is passed by pointer.
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetViewport', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (!device) return D3DERR_INVALIDCALL;
        return device.setViewport(view.getUint32(esp + 8, true), mem);
    }, { trivial: true });

    // IDirect3DDevice9_SetClipPlane(thisPtr, Index, pPlane)
    // CAPTURE-AT-CALL (not WBUF): pPlane points to four guest floats.
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetClipPlane', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (!device) return D3DERR_INVALIDCALL;
        const pPlane = view.getUint32(esp + 12, true);
        if (!validGuestRange(mem, pPlane, D3DCLIPPLANE_SIZE)) return D3DERR_INVALIDCALL;
        const plane = new Float32Array(4);
        for (let i = 0; i < 4; i++) {
            plane[i] = view.getFloat32(pPlane + i * 4, true);
        }
        return device.setClipPlane(view.getUint32(esp + 8, true), plane);
    }, { trivial: true });

    // IDirect3DDevice9_SetVertexDeclaration(thisPtr, pDecl) — resolve COM ptr → handle.
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_SetVertexDeclaration', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (!device) return D3D_OK;
        const pDecl = view.getUint32(esp + 8, true);
        if (pDecl === 0) { device.setVertexDeclaration(0, 0); return D3D_OK; }
        const meta = resolveVertexDeclComPtr(pDecl);
        if (meta) device.setVertexDeclaration(meta.internalHandle, pDecl);
        return D3D_OK;
    }, { trivial: true });

    // ── Draw calls — FastPath OUT-trap handlers. For the scalar draws
    // (DrawPrimitive/DrawIndexedPrimitive) this is now the RING-OVERFLOW FALLBACK:
    // the primary path is the WBUF ring registration below (no trap per draw; the
    // ring drains at the next real trap — Present at the latest — with the draw as
    // a coalesce barrier). DrawPrimitiveUP keeps this as its ONLY path: its vertex
    // data is a guest scratch pointer (capture-at-call requirement, same class as
    // shader constants). Handlers are pure-sync (read args → device.draw* → D3D_OK).
    // NON-trivial: per completeFastPathSync, trapped Draw* always notify the
    // scheduler boundary (no deferral), matching the legacy slow-path behaviour.
    // IDirect3DDevice9_DrawPrimitive(thisPtr, PrimitiveType, StartVertex, PrimitiveCount)
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_DrawPrimitive', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (device) device.drawPrimitive(view.getUint32(esp + 8, true), view.getUint32(esp + 12, true), view.getUint32(esp + 16, true));
        return D3D_OK;
    });

    // IDirect3DDevice9_DrawIndexedPrimitive(thisPtr, PrimitiveType, BaseVertexIndex, MinVertexIndex, NumVertices, StartIndex, PrimitiveCount)
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_DrawIndexedPrimitive', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (device) device.drawIndexedPrimitive(
            view.getUint32(esp + 8, true), view.getInt32(esp + 12, true), view.getUint32(esp + 16, true),
            view.getUint32(esp + 20, true), view.getUint32(esp + 24, true), view.getUint32(esp + 28, true));
        return D3D_OK;
    });

    // IDirect3DDevice9_DrawPrimitiveUP(thisPtr, PrimitiveType, PrimitiveCount, pVertexStreamZeroData, VertexStreamZeroStride)
    dispatcher.registerFastPath('d3d9', 'IDirect3DDevice9_DrawPrimitiveUP', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const device = devices.get(view.getUint32(esp + 4, true));
        if (device) device.drawPrimitiveUP(view.getUint32(esp + 8, true), view.getUint32(esp + 12, true), view.getUint32(esp + 16, true), view.getUint32(esp + 20, true));
        return D3D_OK;
    });

    // ── State blocks — the heaviest remaining slow-path storm (NFSU in-race:
    // ~4.7K Apply + 4.7K Capture traps/s, each through the full _handlePortWriteSlow
    // ladder). Both are pure-sync (map lookup → device method → HRESULT), so they
    // fast-path cleanly. They stay TRAPS (Capture reads live tracker state and Apply
    // must be ordered vs ring setters — the drain-before-every-trap invariant gives
    // both for free).
    // IDirect3DStateBlock9_Apply(thisPtr)
    dispatcher.registerFastPath('d3d9', 'IDirect3DStateBlock9_Apply', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const block = stateBlocks.get(view.getUint32(esp + 4, true));
        const device = block ? devices.get(block.devicePtr) : null;
        if (!block || !device) return D3DERR_INVALIDCALL;
        return device.applyStateBlockData(block);
    }, { trivial: true });

    // IDirect3DStateBlock9_Capture(thisPtr)
    dispatcher.registerFastPath('d3d9', 'IDirect3DStateBlock9_Capture', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const block = stateBlocks.get(view.getUint32(esp + 4, true));
        const device = block ? devices.get(block.devicePtr) : null;
        if (!block || !device) return D3DERR_INVALIDCALL;
        return device.captureStateBlockData(block);
    }, { trivial: true });

    // ── VB/IB Lock/Unlock — the per-draw RenderWare pattern (Lock(NOOVERWRITE) →
    // guest writes vertices → Unlock → Draw), and the largest remaining slow-path
    // consumer in GTA III gameplay.
    //
    // These qualify despite being "Lock": a D3D9 vertex/index buffer's storage is a
    // guest HEAP allocation made once at Create time, so Lock is not an allocation and
    // not a GPU map — it computes guestBase+offset, records the locked range, and hands
    // the pointer back. Unlock copies that range into the CPU shadow and widens the
    // dirty span; the actual GPU upload is batched at draw/present time. No await, no
    // host allocation, no LeaseRegistry entry (§3.1's lease model covers DDraw/GDI
    // surface pixels, whose pointers are borrowed and whose upload paths validate a
    // lease — the buffer stores own their memory and track the lock in lockedPtrs/
    // lockedSizes themselves, which unlock() checks).
    //
    // FastPath (OUT trap), NOT write-buffer: Lock returns a pointer the guest
    // dereferences on the very next instruction, so it cannot be deferred to a drain;
    // and a deferred Unlock would read the guest bytes at drain time, after a later
    // Lock(DISCARD) may have refilled the same range. The trap-time drain of the ring
    // (handlePortWrite → drainWriteBuffer) keeps both correctly ordered against the
    // buffered setters and draws.
    //
    // Returning null (→ slow path) is only used BEFORE any side effect, so the slow
    // path's re-execution is a first execution.
    for (const [iface, lockFn, unlockFn] of [
        ['IDirect3DVertexBuffer9', 'lockVertexBuffer', 'unlockVertexBuffer'],
        ['IDirect3DIndexBuffer9', 'lockIndexBuffer', 'unlockIndexBuffer'],
    ] as const) {
        // Lock(thisPtr, OffsetToLock, SizeToLock, ppbData, Flags)
        dispatcher.registerFastPath('d3d9', `${iface}_Lock`, (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number | null => {
            const esp = cpu.reg32[4];
            const pBuf = view.getUint32(esp + 4, true);
            const device = resourceToDevice.get(pBuf);
            // Unknown buffer / bad out-param: no state touched yet, so let the slow path
            // run it and produce the diagnostic.
            if (!device) return null;
            const ppbData = view.getUint32(esp + 16, true);
            if (ppbData !== 0 && !validGuestRange(mem, ppbData, 4)) return null;
            const dataPtr = (device as any)[lockFn](
                pBuf, view.getUint32(esp + 8, true), view.getUint32(esp + 12, true), view.getUint32(esp + 20, true));
            if (dataPtr === 0) {
                // The lock recorded its flags before refusing, so this cannot fall through.
                Logger.error(LogCategory.D3D9, `${iface}::Lock failed for 0x${pBuf.toString(16)}`);
                if (ppbData !== 0) view.setUint32(ppbData, 0, true);
                return D3DERR_INVALIDCALL;
            }
            if (ppbData !== 0) view.setUint32(ppbData, dataPtr >>> 0, true);
            return D3D_OK;
        }, { trivial: true });

        // Unlock(thisPtr)
        dispatcher.registerFastPath('d3d9', `${iface}_Unlock`, (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number | null => {
            const pBuf = view.getUint32(cpu.reg32[4] + 4, true);
            const device = resourceToDevice.get(pBuf);
            if (!device) return null;
            (device as any)[unlockFn](pBuf, mem);
            return D3D_OK;
        }, { trivial: true });
    }

    // Resource AddRef/Release — pure JS bookkeeping over the same registry the thunk
    // handlers use, so the refcount stays exact while skipping the slow-path ladder.
    // (Per-frame texture/surface churn puts ~100K of each through here per interval;
    // they can no longer be constant-return stubs now that the counts are real.)
    for (const prefix of ['IDirect3DTexture9', 'IDirect3DCubeTexture9', 'IDirect3DSurface9', 'IDirect3DVertexBuffer9', 'IDirect3DIndexBuffer9']) {
        dispatcher.registerFastPath('d3d9', `${prefix}_AddRef`,
            (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number =>
                addD3D9ComRef(prefix, view.getUint32(cpu.reg32[4] + 4, true)),
            { trivial: true });
        dispatcher.registerFastPath('d3d9', `${prefix}_Release`,
            (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number =>
                releaseD3D9ComRef(prefix, view.getUint32(cpu.reg32[4] + 4, true)),
            { trivial: true });
    }

    Logger.log(LogCategory.D3D9, 'Registered FastPath for hot D3D9 state setters, shader constants, draw calls, and resource AddRef/Release');

    // ========================================================================
    // Tier-0 Write-Buffer registrations (the no-trap hot path).
    // Only setters with scalar / stable-pointer args — the shader-constant
    // setters above stay FastPath-only (raw float buffer, reuse hazard).
    // ========================================================================
    if (typeof dispatcher.registerWriteBufferFunction !== 'function') return;

    // SetRenderState (3 args) — guest-side value shadow: ~97% of these re-set the same value
    // (measured, NFSU in-race). Slot = State (this=arg0, State=arg1, Value=arg2). The handler
    // below runs only on a genuine change (or when the device isn't the bound shadow owner).
    // Guest-side setter shadow: short-circuit redundant SetRenderState/SetSamplerState (~97% are
    // measured redundant) in guest code — no ring entry, no JS drain. Coherence is held by the
    // device mirroring every real change back into the shadow (d3d9-device.syncSetterShadow), so it
    // stays a faithful tracker mirror even for paths that bypass the trampoline (notably state-block
    // Apply, which calls device.setRenderState directly). Kill-switch (A/B): globalThis.__noSetterShadow
    // (checked in dispatcher.registerShadowedWriteBufferFunction).
    const regShadowed = typeof dispatcher.registerShadowedWriteBufferFunction === 'function';
    if (regShadowed) {
        dispatcher.registerShadowedWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetRenderState', 3,
            (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (device) device.setRenderState(mem32[(ptr + 4) >> 2], mem32[(ptr + 8) >> 2]);
            }, 0x3,
            { argCount: 3, valueArgIndex: 2, slotCount: 256, keyParts: [{ argIndex: 1, shift: 0, max: 256 }] });
    } else {
        dispatcher.registerWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetRenderState', 3,
            (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (device) device.setRenderState(mem32[(ptr + 4) >> 2], mem32[(ptr + 8) >> 2]);
            }, true, 0x3);
    }

    // SetSamplerState (4 args) — guest-side value shadow. Slot = (Sampler<<4)|Type
    // (this=arg0, Sampler=arg1, Type=arg2, Value=arg3).
    if (regShadowed) {
        dispatcher.registerShadowedWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetSamplerState', 4,
            (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (device) device.setSamplerState(mem32[(ptr + 4) >> 2], mem32[(ptr + 8) >> 2], mem32[(ptr + 12) >> 2]);
            }, 0x7,
            { argCount: 4, valueArgIndex: 3, slotCount: 256, keyParts: [{ argIndex: 1, shift: 4, max: 16 }, { argIndex: 2, shift: 0, max: 16 }] });
    } else {
        dispatcher.registerWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetSamplerState', 4,
            (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (device) device.setSamplerState(mem32[(ptr + 4) >> 2], mem32[(ptr + 8) >> 2], mem32[(ptr + 12) >> 2]);
            }, true, 0x7);
    }

    // SetFVF (2 args)
    dispatcher.registerWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetFVF', 2,
        (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
            const device = devices.get(mem32[ptr >> 2]);
            if (device) device.setFVF(mem32[(ptr + 4) >> 2]);
        }, true, 0x1);

    // SetVertexShader (2 args) — resolve COM ptr → internal handle at drain.
    dispatcher.registerWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetVertexShader', 2,
        (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
            const device = devices.get(mem32[ptr >> 2]);
            if (!device) return;
            const pShader = mem32[(ptr + 4) >> 2];
            if (pShader === 0) { device.setVertexShader(0, 0); return; }
            const meta = resolveVertexShaderComPtr(pShader);
            if (meta) device.setVertexShader(meta.internalHandle, pShader);
        }, true, 0x1);

    // SetPixelShader (2 args)
    dispatcher.registerWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetPixelShader', 2,
        (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
            const device = devices.get(mem32[ptr >> 2]);
            if (!device) return;
            const pShader = mem32[(ptr + 4) >> 2];
            if (pShader === 0) { device.setPixelShader(0, 0); return; }
            const meta = resolvePixelShaderComPtr(pShader);
            if (meta) device.setPixelShader(meta.internalHandle, pShader);
        }, true, 0x1);

    // SetTextureStageState (4 args) — scalar FFP setter, same shape as SetSamplerState.
    dispatcher.registerWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetTextureStageState', 4,
        (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
            const device = devices.get(mem32[ptr >> 2]);
            if (device) device.setTextureStageState(mem32[(ptr + 4) >> 2], mem32[(ptr + 8) >> 2], mem32[(ptr + 12) >> 2]);
        }, true, 0x7);

    // LightEnable (3 args)
    dispatcher.registerWriteBufferFunction('d3d9', 'IDirect3DDevice9_LightEnable', 3,
        (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
            const device = devices.get(mem32[ptr >> 2]);
            if (device) device.lightEnable(mem32[(ptr + 4) >> 2], mem32[(ptr + 8) >> 2]);
        }, true, 0x3);

    // SetVertexDeclaration (2 args) — stable COM ptr, resolved → internal handle at drain.
    dispatcher.registerWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetVertexDeclaration', 2,
        (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
            const device = devices.get(mem32[ptr >> 2]);
            if (!device) return;
            const pDecl = mem32[(ptr + 4) >> 2];
            if (pDecl === 0) { device.setVertexDeclaration(0, 0); return; }
            const meta = resolveVertexDeclComPtr(pDecl);
            if (meta) device.setVertexDeclaration(meta.internalHandle, pDecl);
        }, true, 0x1);

    // ── Draw calls on the ring (kill the per-draw OUT trap) ──────────────────
    // A draw does NOT need to be the trap that drains the ring: the ring drains at
    // the start of EVERY OUT trap (Present/EndScene/Lock/SetTransform/...), so a
    // buffered draw is applied — in program order, after every setter buffered
    // before it — no later than the next real trap (Present at the latest). What a
    // draw DOES need is barrier semantics inside the ring: it OBSERVES buffered
    // state, so the drain-side coalescer must not apply a later same-key setter
    // across it (barrier:true → per-segment coalesce keys in drainWriteBuffer).
    // Scalar-arg draws only: DrawPrimitiveUP/DrawIndexedPrimitiveUP pass guest
    // scratch pointers (capture-at-call required) and stay on the FastPath trap.
    // The FastPath handlers above remain the ring-overflow fallback.
    // Kill-switch (A/B, boot-time): globalThis.__noDrawWbuf.
    if (!(globalThis as any).__noDrawWbuf) {
        // DrawPrimitive(thisPtr, PrimitiveType, StartVertex, PrimitiveCount)
        dispatcher.registerWriteBufferFunction('d3d9', 'IDirect3DDevice9_DrawPrimitive', 4,
            (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (device) device.drawPrimitive(mem32[(ptr + 4) >> 2], mem32[(ptr + 8) >> 2], mem32[(ptr + 12) >> 2]);
            }, true, 0, { barrier: true });

        // DrawIndexedPrimitive(thisPtr, PrimitiveType, BaseVertexIndex, MinVertexIndex, NumVertices, StartIndex, PrimitiveCount)
        // BaseVertexIndex is signed (| 0 matches the FastPath handler's getInt32).
        dispatcher.registerWriteBufferFunction('d3d9', 'IDirect3DDevice9_DrawIndexedPrimitive', 7,
            (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (device) device.drawIndexedPrimitive(
                    mem32[(ptr + 4) >> 2], mem32[(ptr + 8) >> 2] | 0, mem32[(ptr + 12) >> 2],
                    mem32[(ptr + 16) >> 2], mem32[(ptr + 20) >> 2], mem32[(ptr + 24) >> 2]);
            }, true, 0, { barrier: true });
    }

    // ── State-block Capture/Apply on the ring (kill the 192 OUT hops/frame).
    // Capture only READS
    // device state; barrier:true gives it program order vs ring setters at drain
    // (earlier setters applied first, later ones can't coalesce across it), and a
    // setter short-circuited by the guest-side value shadow was value-identical, so a
    // deferred Capture still snapshots the right state.
    //
    // Apply WRITES device state, and the setter-shadow trampolines compare against
    // their guest-memory shadow AT CALL TIME — a guest setter issued after a plain
    // ring-deferred Apply would compare against the pre-Apply shadow value and wrongly
    // skip; the drain-time Apply then clobbers the state the skipped setter should have
    // re-established (which flickers/blacks out surfaces). So Apply rides an
    // OWNER-DISARM trampoline: it zeroes the shadow
    // owner gate before writing its ring entry, routing every subsequent shadowed
    // setter to the ring (correct order, no stale skip) until the drain handler below
    // re-arms the owner AFTER applyStateBlockData synced the shadows
    // (device.syncSetterShadow covers state-block Apply by design).
    // Kill-switch (A/B, boot-time): globalThis.__noStateBlockWbuf.
    if (!(globalThis as any).__noStateBlockWbuf) {
        // IDirect3DStateBlock9_Capture(thisPtr)
        dispatcher.registerWriteBufferFunction('d3d9', 'IDirect3DStateBlock9_Capture', 1,
            (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const block = stateBlocks.get(mem32[ptr >> 2]);
                const device = block ? devices.get(block.devicePtr) : null;
                if (block && device) device.captureStateBlockData(block);
            }, true, 0, { barrier: true });

        // IDirect3DStateBlock9_Apply(thisPtr) — owner-disarm ring entry (see above).
        if (typeof dispatcher.registerOwnerDisarmWriteBufferFunction === 'function') {
            dispatcher.registerOwnerDisarmWriteBufferFunction('d3d9', 'IDirect3DStateBlock9_Apply', 1,
                (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                    const block = stateBlocks.get(mem32[ptr >> 2]);
                    const device = block ? devices.get(block.devicePtr) : null;
                    if (block && device) {
                        device.applyStateBlockData(block);
                        // Shadows are now coherent (Apply synced every real change) —
                        // re-arm the owner gate so setter skipping resumes.
                        dispatcher.setShadowOwner(block.devicePtr);
                    }
                }, 0, { barrier: true });
        }
    }

    // ── Struct setters on the ring (capture-at-call trampolines) ─────────────
    // SetTransform/SetMaterial/SetLight/SetViewport/SetClipPlane pass pointer-to-
    // struct args the guest may reuse before drain — the trampoline copies the
    // struct bytes INTO the ring at call time; the drain handler reads them from
    // the ring (guest RAM), never from the original pointer. FastPath above stays
    // as the ring-overflow / bad-pointer fallback. Kill-switch: __noStructCapture.
    if (typeof dispatcher.registerStructCaptureWriteBufferFunction === 'function'
        && !(globalThis as any).__noStructCapture) {
        // SetTransform(this, State, pMatrix[16 floats]) — payload at ptr+12.
        dispatcher.registerStructCaptureWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetTransform', 3, 2, 16,
            (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (!device) return;
                const f = new Float32Array(16);
                const u = new Uint32Array(f.buffer);
                const w = (ptr + 12) >> 2;
                for (let i = 0; i < 16; i++) u[i] = mem32[w + i];
                device.setTransform(mem32[(ptr + 4) >> 2], f);
            });

        // SetMaterial(this, pMaterial[68 bytes = 17 dwords]) — payload at ptr+8.
        dispatcher.registerStructCaptureWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetMaterial', 2, 1, 17,
            (mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (device) device.setMaterial(mem8.subarray(ptr + 8, ptr + 8 + D3DMATERIAL9_SIZE));
            });

        // SetLight(this, Index, pLight[104 bytes = 26 dwords]) — payload at ptr+12.
        dispatcher.registerStructCaptureWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetLight', 3, 2, 26,
            (mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (device) device.setLight(mem32[(ptr + 4) >> 2], mem8.subarray(ptr + 12, ptr + 12 + D3DLIGHT9_SIZE));
            });

        // SetViewport(this, pViewport[24 bytes = 6 dwords]) — payload at ptr+8; the device
        // reads the D3DVIEWPORT9 from guest memory, so pass the ring address of the copy.
        dispatcher.registerStructCaptureWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetViewport', 2, 1, 6,
            (mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (device) device.setViewport(ptr + 8, mem8);
            });

        // SetClipPlane(this, Index, pPlane[4 floats]) — payload at ptr+12.
        dispatcher.registerStructCaptureWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetClipPlane', 3, 2, 4,
            (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (!device) return;
                const f = new Float32Array(4);
                const u = new Uint32Array(f.buffer);
                const w = (ptr + 12) >> 2;
                for (let i = 0; i < 4; i++) u[i] = mem32[w + i];
                device.setClipPlane(mem32[(ptr + 4) >> 2], f);
            });
    }

    // ── DrawPrimitiveUP on the ring (capture-at-call) ────────────────────────
    // The trampoline computes vertexCount×stride in x86 and copies the vertex
    // bytes into the ring; the drain passes the ring address of the captured
    // bytes to the device (drawPrimitiveUP reads/converts synchronously). Barrier
    // entry like the scalar draws. Shares the __noDrawWbuf kill-switch.
    if (typeof dispatcher.registerUpDrawWriteBufferFunction === 'function'
        && !(globalThis as any).__noDrawWbuf) {
        dispatcher.registerUpDrawWriteBufferFunction('d3d9', 'IDirect3DDevice9_DrawPrimitiveUP',
            (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (device) device.drawPrimitiveUP(
                    mem32[(ptr + 4) >> 2], mem32[(ptr + 8) >> 2], ptr + 20, mem32[(ptr + 12) >> 2]);
            });
    }

    // Shader constants — WBUF with inline capture-at-call (dedicated trampoline).
    if (typeof dispatcher.registerShaderConstantWriteBufferFunction === 'function') {
        dispatcher.registerShaderConstantWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetVertexShaderConstantF',
            (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (device) device.setVertexShaderConstantFFromWbufRing(mem32, ptr);
            });
        dispatcher.registerShaderConstantWriteBufferFunction('d3d9', 'IDirect3DDevice9_SetPixelShaderConstantF',
            (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
                const device = devices.get(mem32[ptr >> 2]);
                if (device) device.setPixelShaderConstantFFromWbufRing(mem32, ptr);
            });
    }

    Logger.log(LogCategory.D3D9, 'Registered Tier-0 write-buffer stubs for scalar/stable-pointer D3D9 state setters and shader constants');
}
