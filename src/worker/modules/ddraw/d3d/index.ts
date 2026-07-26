/**
 * D3D Module - Entry Point
 *
 * Combines all D3D implementations into a single exports object.
 * This replaces the monolithic d3d.ts file with a modular structure.
 */
import { ThunkImplementation } from "../../../core/thunking/thunk-dispatcher";
import { DDrawContext } from "../context";
import { Logger, LogCategory } from "../../../core/logger";
import { Direct3DDevice3Object, Direct3DDevice7Object } from "../com-objects";

import { createTextureManager } from "./texture-manager";
import { createDrawHandler } from "./draw-handler";
import { createViewportExports } from "./viewport-impl";
import { createD3DInterfaceExports } from "./d3d-impl";
import { createDeviceExports } from "./device-impl";
import { createTextureExports } from "./texture-impl";
import { createLightMaterialExports } from "./light-material-impl";
import { createExecuteBufferExports } from "./execute-buffer-impl";

// D3D_OK constant
const D3D_OK = 0;

// Shared DrawHandler instance for FastPath access
let sharedDrawHandler: ReturnType<typeof createDrawHandler> | null = null;

// Diagnostic: track RS[41] (COLORKEYENABLE) values from the game (first 20 calls)

export const createD3DExports = (context: DDrawContext): Record<string, ThunkImplementation> => {
    // 1. Initialize helpers
    const textureManager = createTextureManager(context);
    const drawHandler = createDrawHandler(context, textureManager);

    // Store for FastPath access
    sharedDrawHandler = drawHandler;

    // 2. Combine exports from all modules
    const exports: Record<string, ThunkImplementation> = {
        ...createViewportExports(context),
        ...createD3DInterfaceExports(context),
        ...createDeviceExports(context, textureManager, drawHandler),
        ...createTextureExports(context, textureManager),
        ...createLightMaterialExports(context),
    };
    // The execute-buffer interpreter replays opcodes onto the handlers above,
    // so it is wired last and takes the merged table.
    Object.assign(exports, createExecuteBufferExports(context, drawHandler, exports));
    return exports;
};

/**
 * Register FastPath implementations for high-frequency D3D functions.
 * FastPath bypasses X86Context creation and reads arguments directly from stack.
 * This significantly reduces thunking overhead for functions called 100K+ times per frame.
 */
export function registerFastPathD3DFunctions(dispatcher: any, context: DDrawContext): void {
    if (!dispatcher || typeof dispatcher.registerFastPath !== 'function') {
        return;
    }

    const resourceProvider = context.resourceProvider;

    // Device object cache: getComObjectByAddress is a Map lookup called 600K+/frame.
    // The device thisPtr is stable for the entire game session — cache it once.
    let lastD3D3Ptr = 0;
    let lastD3D3Obj: Direct3DDevice3Object | null = null;
    let lastD3D3TSS: Int32Array | null = null; // direct ref to textureStageStates array

    let lastD3D7Ptr = 0;
    let lastD3D7Obj: Direct3DDevice7Object | null = null;
    let lastD3D7TSS: Int32Array | null = null;

    // DD_OK (0) for surface fastpaths
    const DD_OK = 0;

    // ============================================================================
    // IDirect3DDevice3_SetRenderState - 206K calls, 728ms total
    // ============================================================================
    dispatcher.registerFastPath('ddraw', 'IDirect3DDevice3_SetRenderState', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4]; // ESP register

        // Stack layout (stdcall, args pushed right-to-left):
        // esp + 0  = return address
        // esp + 4  = thisPtr (IDirect3DDevice3*)
        // esp + 8  = state (D3DRENDERSTATETYPE)
        // esp + 12 = value (DWORD)
        const thisPtr = view.getUint32(esp + 4, true);
        const state = view.getUint32(esp + 8, true);
        const value = view.getUint32(esp + 12, true);

        if (thisPtr !== lastD3D3Ptr) {
            lastD3D3Ptr = thisPtr;
            lastD3D3Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
            lastD3D3TSS = lastD3D3Obj?.getAllTextureStageStates() ?? null;
        }
        const obj = lastD3D3Obj;
        if (obj) {
            // setRenderState handles dedup internally; legacy texture states must always
            // retranslate even if value is unchanged (TSS may have been overwritten).
            obj.setRenderState(state, value);
        }

        return D3D_OK;
    }, { trivial: true });

    // ============================================================================
    // IDirect3DDevice3_SetTextureStageState - 422K calls, 3313ms total
    // No deduplication previously — now skips redundant writes via cached TSS array.
    // ============================================================================
    dispatcher.registerFastPath('ddraw', 'IDirect3DDevice3_SetTextureStageState', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];

        // esp + 4  = thisPtr
        // esp + 8  = stage
        // esp + 12 = type
        // esp + 16 = value
        const thisPtr = view.getUint32(esp + 4, true);
        const stage = view.getUint32(esp + 8, true);
        const type = view.getUint32(esp + 12, true);
        const value = view.getUint32(esp + 16, true);

        if (thisPtr !== lastD3D3Ptr) {
            lastD3D3Ptr = thisPtr;
            lastD3D3Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
            lastD3D3TSS = lastD3D3Obj?.getAllTextureStageStates() ?? null;
        }
        // Direct TSS array write: skips the setTextureStageState() call overhead.
        // getAllTextureStageStates() returns the live Int32Array (not a copy).
        if (lastD3D3TSS) {
            const idx = (stage * 32 + type) | 0;
            if ((idx >>> 0) < 256 && lastD3D3TSS[idx] !== value) {
                lastD3D3TSS[idx] = value;
            }
        }

        return D3D_OK;
    }, { trivial: true });

    // ============================================================================
    // IDirect3DDevice7_SetRenderState
    // ============================================================================
    dispatcher.registerFastPath('ddraw', 'IDirect3DDevice7_SetRenderState', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];

        const thisPtr = view.getUint32(esp + 4, true);
        const state = view.getUint32(esp + 8, true);
        const value = view.getUint32(esp + 12, true);

        if (thisPtr !== lastD3D7Ptr) {
            lastD3D7Ptr = thisPtr;
            lastD3D7Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
            lastD3D7TSS = lastD3D7Obj?.getAllTextureStageStates() ?? null;
        }
        const obj = lastD3D7Obj;
        if (obj) {
            obj.setRenderState(state, value);
        }

        return D3D_OK;
    }, { trivial: true });

    // ============================================================================
    // IDirect3DDevice7_SetTextureStageState
    // ============================================================================
    dispatcher.registerFastPath('ddraw', 'IDirect3DDevice7_SetTextureStageState', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];

        const thisPtr = view.getUint32(esp + 4, true);
        const stage = view.getUint32(esp + 8, true);
        const type = view.getUint32(esp + 12, true);
        const value = view.getUint32(esp + 16, true);

        if (thisPtr !== lastD3D7Ptr) {
            lastD3D7Ptr = thisPtr;
            lastD3D7Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
            lastD3D7TSS = lastD3D7Obj?.getAllTextureStageStates() ?? null;
        }
        if (lastD3D7TSS) {
            const idx = (stage * 32 + type) | 0;
            if ((idx >>> 0) < 256 && lastD3D7TSS[idx] !== value) {
                lastD3D7TSS[idx] = value;
            }
        }

        return D3D_OK;
    }, { trivial: true });

    // ============================================================================
    // IDirect3DDevice7_SetTransform — per-draw world/view/proj matrix upload.
    // Reads 16 floats from guest memory into a reused scratch Float32Array and
    // forwards to Direct3DDevice7Object.setTransform (which copies into its own
    // matrix storage, so the scratch buffer is safe to reuse across calls).
    // Skips the diagnostic logging in the slow-path impl.
    // ============================================================================
    const transformScratch7 = new Float32Array(16);
    dispatcher.registerFastPath('ddraw', 'IDirect3DDevice7_SetTransform', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const thisPtr = view.getUint32(esp + 4, true);
        const state   = view.getUint32(esp + 8, true);
        const pMatrix = view.getUint32(esp + 12, true);
        if (pMatrix === 0) return D3D_OK;

        if (thisPtr !== lastD3D7Ptr) {
            lastD3D7Ptr = thisPtr;
            lastD3D7Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
            lastD3D7TSS = lastD3D7Obj?.getAllTextureStageStates() ?? null;
        }
        if (!lastD3D7Obj) return D3D_OK;

        for (let i = 0; i < 16; i++) {
            transformScratch7[i] = view.getFloat32(pMatrix + i * 4, true);
        }
        // D3D3 WORLD=1 mapped to D3D7 WORLD=256 (games often mix constants).
        const normalizedState = state === 1 ? 256 : state;
        lastD3D7Obj.setTransform(normalizedState, transformScratch7);
        return D3D_OK;
    }, { trivial: true });

    // ============================================================================
    // IDirect3DDevice7_SetMaterial — per-draw material upload (68-byte struct).
    // Skips slow-path diagnostic block that rebuilds a key string on every call.
    // ============================================================================
    dispatcher.registerFastPath('ddraw', 'IDirect3DDevice7_SetMaterial', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const thisPtr    = view.getUint32(esp + 4, true);
        const lpMaterial = view.getUint32(esp + 8, true);
        if (lpMaterial === 0) return D3D_OK;

        if (thisPtr !== lastD3D7Ptr) {
            lastD3D7Ptr = thisPtr;
            lastD3D7Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
            lastD3D7TSS = lastD3D7Obj?.getAllTextureStageStates() ?? null;
        }
        if (!lastD3D7Obj) return D3D_OK;

        // D3DMATERIAL7 layout: diffuse/ambient/specular/emissive (4×D3DCOLORVALUE=16B each) + power (float).
        lastD3D7Obj.setMaterial({
            diffuse:  { r: view.getFloat32(lpMaterial + 0,  true), g: view.getFloat32(lpMaterial + 4,  true), b: view.getFloat32(lpMaterial + 8,  true), a: view.getFloat32(lpMaterial + 12, true) },
            ambient:  { r: view.getFloat32(lpMaterial + 16, true), g: view.getFloat32(lpMaterial + 20, true), b: view.getFloat32(lpMaterial + 24, true), a: view.getFloat32(lpMaterial + 28, true) },
            specular: { r: view.getFloat32(lpMaterial + 32, true), g: view.getFloat32(lpMaterial + 36, true), b: view.getFloat32(lpMaterial + 40, true), a: view.getFloat32(lpMaterial + 44, true) },
            emissive: { r: view.getFloat32(lpMaterial + 48, true), g: view.getFloat32(lpMaterial + 52, true), b: view.getFloat32(lpMaterial + 56, true), a: view.getFloat32(lpMaterial + 60, true) },
            power:    view.getFloat32(lpMaterial + 64, true),
        });
        return D3D_OK;
    }, { trivial: true });

    // ============================================================================
    // IDirect3DDevice7_GetRenderState — per-draw state readback; trivial lookup + write.
    // ============================================================================
    dispatcher.registerFastPath('ddraw', 'IDirect3DDevice7_GetRenderState', (cpu: any, _mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];
        const thisPtr = view.getUint32(esp + 4, true);
        const state   = view.getUint32(esp + 8, true);
        const pValue  = view.getUint32(esp + 12, true);
        if (pValue === 0) return D3D_OK;

        if (thisPtr !== lastD3D7Ptr) {
            lastD3D7Ptr = thisPtr;
            lastD3D7Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
            lastD3D7TSS = lastD3D7Obj?.getAllTextureStageStates() ?? null;
        }
        if (!lastD3D7Obj) return D3D_OK;

        view.setUint32(pValue, lastD3D7Obj.getRenderState(state) >>> 0, true);
        return D3D_OK;
    }, { trivial: true });

    // ============================================================================
    // IDirectDrawSurface4/7_IsLost — 10K calls/48 frames, trivial no-op in emu.
    // Surfaces never become "lost" in our environment; always return DD_OK.
    // ============================================================================
    const isLostFn = (_cpu: any, _mem: Uint8Array, _mem32: Uint32Array, _view: DataView): number => DD_OK;
    dispatcher.registerFastPath('ddraw', 'IDirectDrawSurface4_IsLost', isLostFn, { trivial: true });
    dispatcher.registerFastPath('ddraw', 'IDirectDrawSurface7_IsLost', isLostFn, { trivial: true });

    // ============================================================================
    // IDirect3DDevice3_DrawPrimitive - 393K calls, 3002ms total (1163ms in drawPrimitive)
    // FastPath saves ~1.8 sec thunking overhead
    // ============================================================================
    dispatcher.registerFastPath('ddraw', 'IDirect3DDevice3_DrawPrimitive', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        if (!sharedDrawHandler) return D3D_OK;

        const esp = cpu.reg32[4];

        // Stack layout:
        // esp + 4  = thisPtr (IDirect3DDevice3*)
        // esp + 8  = primitiveType (D3DPRIMITIVETYPE)
        // esp + 12 = vertexType (DWORD - FVF flags)
        // esp + 16 = lpVertices (void*)
        // esp + 20 = vertexCount (DWORD)
        const thisPtr = view.getUint32(esp + 4, true);
        const primitiveType = view.getUint32(esp + 8, true);
        const vertexType = view.getUint32(esp + 12, true);
        const lpVertices = view.getUint32(esp + 16, true);
        const vertexCount = view.getUint32(esp + 20, true);

        sharedDrawHandler.handleDrawPrimitive(thisPtr, primitiveType, vertexType, lpVertices, vertexCount, mem);
        return D3D_OK;
    });

    // ============================================================================
    // IDirect3DDevice7_DrawPrimitive
    // ============================================================================
    dispatcher.registerFastPath('ddraw', 'IDirect3DDevice7_DrawPrimitive', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        if (!sharedDrawHandler) return D3D_OK;

        const esp = cpu.reg32[4];

        const thisPtr = view.getUint32(esp + 4, true);
        const primitiveType = view.getUint32(esp + 8, true);
        const vertexType = view.getUint32(esp + 12, true);
        const lpVertices = view.getUint32(esp + 16, true);
        const vertexCount = view.getUint32(esp + 20, true);

        sharedDrawHandler.handleDrawPrimitive(thisPtr, primitiveType, vertexType, lpVertices, vertexCount, mem);
        return D3D_OK;
    });

    // ============================================================================
    // IDirect3DDevice3_DrawIndexedPrimitive - thousands of calls per frame (Sea Dogs: 4511)
    // Same as DrawPrimitive but with 3 extra args: lpIndices, indexCount, flags
    // ============================================================================
    dispatcher.registerFastPath('ddraw', 'IDirect3DDevice3_DrawIndexedPrimitive', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        if (!sharedDrawHandler) return D3D_OK;

        const esp = cpu.reg32[4];

        // Stack layout:
        // esp + 4  = thisPtr (IDirect3DDevice3*)
        // esp + 8  = primitiveType (D3DPRIMITIVETYPE)
        // esp + 12 = vertexType (DWORD - FVF flags)
        // esp + 16 = lpVertices (void*)
        // esp + 20 = vertexCount (DWORD)
        // esp + 24 = lpIndices (WORD*)
        // esp + 28 = indexCount (DWORD)
        // esp + 32 = flags (DWORD) - ignored
        const thisPtr = view.getUint32(esp + 4, true);
        const primitiveType = view.getUint32(esp + 8, true);
        const vertexType = view.getUint32(esp + 12, true);
        const lpVertices = view.getUint32(esp + 16, true);
        const vertexCount = view.getUint32(esp + 20, true);
        const lpIndices = view.getUint32(esp + 24, true);
        const indexCount = view.getUint32(esp + 28, true);

        sharedDrawHandler.handleDrawPrimitive(thisPtr, primitiveType, vertexType, lpVertices, vertexCount, mem, true, lpIndices, indexCount);
        return D3D_OK;
    });

    // ============================================================================
    // IDirect3DDevice7_DrawIndexedPrimitive
    // ============================================================================
    dispatcher.registerFastPath('ddraw', 'IDirect3DDevice7_DrawIndexedPrimitive', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        if (!sharedDrawHandler) return D3D_OK;

        const esp = cpu.reg32[4];

        const thisPtr = view.getUint32(esp + 4, true);
        const primitiveType = view.getUint32(esp + 8, true);
        const vertexType = view.getUint32(esp + 12, true);
        const lpVertices = view.getUint32(esp + 16, true);
        const vertexCount = view.getUint32(esp + 20, true);
        const lpIndices = view.getUint32(esp + 24, true);
        const indexCount = view.getUint32(esp + 28, true);

        sharedDrawHandler.handleDrawPrimitive(thisPtr, primitiveType, vertexType, lpVertices, vertexCount, mem, true, lpIndices, indexCount);
        return D3D_OK;
    });

    // ============================================================================
    // IDirect3DDevice3_SetTexture - 36K calls, 198ms total
    // Note: This is a simplified fast path that only updates the device state.
    // Eager texture sync is deferred to DrawPrimitive for better batching.
    // ============================================================================
    dispatcher.registerFastPath('ddraw', 'IDirect3DDevice3_SetTexture', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];

        // esp + 4  = thisPtr
        // esp + 8  = stage
        // esp + 12 = texture (handle or surface address)
        const thisPtr = view.getUint32(esp + 4, true);
        const stage = view.getUint32(esp + 8, true);
        const texture = view.getUint32(esp + 12, true);

        if (thisPtr !== lastD3D3Ptr) {
            lastD3D3Ptr = thisPtr;
            lastD3D3Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
            lastD3D3TSS = lastD3D3Obj?.getAllTextureStageStates() ?? null;
        }
        const obj = lastD3D3Obj;
        if (obj) {
            const current = obj.getTexture(stage);
            if (current !== texture) {
                obj.setTexture(stage, texture);
            }
        }

        return D3D_OK;
    }, { trivial: true });

    // ============================================================================
    // IDirect3DDevice7_SetTexture
    // ============================================================================
    dispatcher.registerFastPath('ddraw', 'IDirect3DDevice7_SetTexture', (cpu: any, mem: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
        const esp = cpu.reg32[4];

        const thisPtr = view.getUint32(esp + 4, true);
        const stage = view.getUint32(esp + 8, true);
        const texture = view.getUint32(esp + 12, true);

        if (thisPtr !== lastD3D7Ptr) {
            lastD3D7Ptr = thisPtr;
            lastD3D7Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
            lastD3D7TSS = lastD3D7Obj?.getAllTextureStageStates() ?? null;
        }
        const obj = lastD3D7Obj;
        if (obj) {
            const current = obj.getTexture(stage);
            if (current !== texture) {
                obj.setTexture(stage, texture);
            }
        }

        return D3D_OK;
    }, { trivial: true });

    Logger.log(LogCategory.DDRAW, 'Registered FastPath for D3D DrawPrimitive/DrawIndexedPrimitive/SetRenderState/SetTextureStageState/SetTexture');

    // ============================================================================
    // Tier-0 Write-Buffer registrations
    // The fast-path registrations above remain as overflow fallback (OUT trap path).
    // Normal execution: JMP trampoline → ring buffer → drain at DrawPrimitive.
    // ============================================================================
    if (typeof dispatcher.registerWriteBufferFunction !== 'function') return;

    // IDirect3DDevice3_SetRenderState (3 args: thisPtr, state, value)
    dispatcher.registerWriteBufferFunction('ddraw', 'IDirect3DDevice3_SetRenderState', 3,
        (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
            const thisPtr = mem32[ptr >> 2];
            const state   = mem32[(ptr + 4) >> 2];
            const value   = mem32[(ptr + 8) >> 2];
            if (thisPtr !== lastD3D3Ptr) {
                lastD3D3Ptr = thisPtr;
                lastD3D3Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
                lastD3D3TSS = lastD3D3Obj?.getAllTextureStageStates() ?? null;
            }
            if (lastD3D3Obj) {
                lastD3D3Obj.setRenderState(state, value);
            }
        }, true /* stdcall */);

    // IDirect3DDevice3_SetTextureStageState (4 args: thisPtr, stage, type, value)
    dispatcher.registerWriteBufferFunction('ddraw', 'IDirect3DDevice3_SetTextureStageState', 4,
        (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
            const thisPtr = mem32[ptr >> 2];
            const stage   = mem32[(ptr + 4) >> 2];
            const type    = mem32[(ptr + 8) >> 2];
            const value   = mem32[(ptr + 12) >> 2];
            if (thisPtr !== lastD3D3Ptr) {
                lastD3D3Ptr = thisPtr;
                lastD3D3Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
                lastD3D3TSS = lastD3D3Obj?.getAllTextureStageStates() ?? null;
            }
            if (lastD3D3TSS) {
                const idx = (stage * 32 + type) | 0;
                if ((idx >>> 0) < 256 && lastD3D3TSS[idx] !== value) lastD3D3TSS[idx] = value;
            }
        }, true);

    // IDirect3DDevice3_SetTexture (3 args: thisPtr, stage, texture)
    dispatcher.registerWriteBufferFunction('ddraw', 'IDirect3DDevice3_SetTexture', 3,
        (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
            const thisPtr  = mem32[ptr >> 2];
            const stage    = mem32[(ptr + 4) >> 2];
            const texture  = mem32[(ptr + 8) >> 2];
            if (thisPtr !== lastD3D3Ptr) {
                lastD3D3Ptr = thisPtr;
                lastD3D3Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
                lastD3D3TSS = lastD3D3Obj?.getAllTextureStageStates() ?? null;
            }
            if (lastD3D3Obj) {
                if (lastD3D3Obj.getTexture(stage) !== texture) lastD3D3Obj.setTexture(stage, texture);
            }
        }, true);

    // IDirect3DDevice7_SetRenderState (3 args: thisPtr, state, value)
    dispatcher.registerWriteBufferFunction('ddraw', 'IDirect3DDevice7_SetRenderState', 3,
        (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
            const thisPtr = mem32[ptr >> 2];
            const state   = mem32[(ptr + 4) >> 2];
            const value   = mem32[(ptr + 8) >> 2];
            if (thisPtr !== lastD3D7Ptr) {
                lastD3D7Ptr = thisPtr;
                lastD3D7Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
                lastD3D7TSS = lastD3D7Obj?.getAllTextureStageStates() ?? null;
            }
            if (lastD3D7Obj) {
                lastD3D7Obj.setRenderState(state, value);
            }
        }, true);

    // IDirect3DDevice7_SetTextureStageState (4 args: thisPtr, stage, type, value)
    dispatcher.registerWriteBufferFunction('ddraw', 'IDirect3DDevice7_SetTextureStageState', 4,
        (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
            const thisPtr = mem32[ptr >> 2];
            const stage   = mem32[(ptr + 4) >> 2];
            const type    = mem32[(ptr + 8) >> 2];
            const value   = mem32[(ptr + 12) >> 2];
            if (thisPtr !== lastD3D7Ptr) {
                lastD3D7Ptr = thisPtr;
                lastD3D7Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
                lastD3D7TSS = lastD3D7Obj?.getAllTextureStageStates() ?? null;
            }
            if (lastD3D7TSS) {
                const idx = (stage * 32 + type) | 0;
                if ((idx >>> 0) < 256 && lastD3D7TSS[idx] !== value) lastD3D7TSS[idx] = value;
            }
        }, true);

    // IDirect3DDevice7_SetTexture (3 args: thisPtr, stage, texture)
    dispatcher.registerWriteBufferFunction('ddraw', 'IDirect3DDevice7_SetTexture', 3,
        (_mem8: Uint8Array, mem32: Uint32Array, ptr: number) => {
            const thisPtr  = mem32[ptr >> 2];
            const stage    = mem32[(ptr + 4) >> 2];
            const texture  = mem32[(ptr + 8) >> 2];
            if (thisPtr !== lastD3D7Ptr) {
                lastD3D7Ptr = thisPtr;
                lastD3D7Obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
                lastD3D7TSS = lastD3D7Obj?.getAllTextureStageStates() ?? null;
            }
            if (lastD3D7Obj) {
                if (lastD3D7Obj.getTexture(stage) !== texture) lastD3D7Obj.setTexture(stage, texture);
            }
        }, true);

    Logger.log(LogCategory.DDRAW, 'Registered Tier-0 write-buffer stubs for D3D SetRenderState/SetTextureStageState/SetTexture');
}
