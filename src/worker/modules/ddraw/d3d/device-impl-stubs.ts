/**
 * IDirect3DDevice7 and IDirect3DDevice3 stub methods (low priority, not yet implemented).
 *
 * A name listed here that device-impl.ts also implements is dead weight — the merge
 * (assignStubsOnce) keeps the real handler — and `tools/validate-stub-tables.ts` fails
 * the gate on it, so this stays enforced rather than remembered.
 */
import type { ThunkImplementation } from "../../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../../core/logger";
import { D3D_OK } from "./types";

export function createDeviceStubsExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const stubCallCounts: Record<string, number> = {};
    const stubLogMethods = new Set([
        "Begin",
        "BeginIndexed",
        "Vertex",
        "Index",
        "End",
        "GetTexture",
        "GetTextureStageState",
    ]);

    const d3dDevice7Stubs = [
        "DrawPrimitiveStrided",
        "DrawIndexedPrimitiveStrided",
        "SetClipPlane",
        "GetClipPlane",
        "GetInfo",
    ];

    for (const method of d3dDevice7Stubs) {
        exports[`IDirect3DDevice7_${method}`] = () => D3D_OK;
    }

    // PreLoad: managed-texture VRAM residency hint — no-op in our direct-pointer model.
    exports["IDirect3DDevice7_PreLoad"] = (_ctx, _mem, _args) => D3D_OK;

    const d3dDevice3Stubs = [
        "GetStats",
        "NextViewport",
        "Begin",
        "BeginIndexed",
        "Vertex",
        "Index",
        "End",
        "GetLightState",
        "SetLightState",
    ];

    for (const method of d3dDevice3Stubs) {
        if (stubLogMethods.has(method)) {
            exports[`IDirect3DDevice3_${method}`] = (ctx, mem, args) => {
                const count = (stubCallCounts[method] = (stubCallCounts[method] || 0) + 1);
                if (count <= 5 || count % 200 === 0) {
                    const a0 = args[0] ?? 0;
                    const a1 = args[1] ?? 0;
                    const a2 = args[2] ?? 0;
                    Logger.log(
                        LogCategory.DDRAW,
                        `IDirect3DDevice3_${method}: called count=${count} a0=0x${a0.toString(16)} a1=0x${a1.toString(16)} a2=0x${a2.toString(16)}`
                    );
                }
                return D3D_OK;
            };
        } else {
            exports[`IDirect3DDevice3_${method}`] = () => D3D_OK;
        }
    }

    return exports;
}
