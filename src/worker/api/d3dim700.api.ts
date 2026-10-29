/**
 * d3dim700.dll — the Direct3D 7 immediate-mode runtime that DirectDraw loads internally.
 *
 * Its exports are private entry points between ddraw.dll and d3dim700.dll, not a public
 * API: no header declares them, so no argument contract is claimed here. The module exists
 * because the library is present on every Windows that runs DirectX 7 titles, and some
 * titles load it themselves (a wrapper resolving these names from its DllMain). Our DDraw
 * never calls into it; a guest call stops the process with the entry point named
 * (System.reportGuestCrash ends every guest thread and stops the CPU, so the return
 * value below never reaches the guest). The eighteen names are those Wine's
 * dlls/d3dim700/d3dim700.spec lists (all stubs there), the set the library exports.
 */
import { ModuleDescriptor } from "./types";

export const D3DIM700_EXPORTS = [
    "D3DFree", "D3DMalloc", "D3DRealloc", "Direct3DCreateDevice", "CreateTexture",
    "D3DBreakVBLock", "D3DTextureUpdate", "DestroyTexture", "Direct3DCreate",
    "Direct3D_HALCleanUp", "FlushD3DDevices", "GetLOD", "GetPriority",
    "PaletteAssociateNotify", "PaletteUpdateNotify", "SetLOD", "SetPriority", "SurfaceFlipNotify",
] as const;

export const d3dim700Module: ModuleDescriptor = {
    name: "d3dim700",
    description: "Direct3D 7 immediate-mode runtime (load-only; private entry points)",
    functions: D3DIM700_EXPORTS.map((name) => ({
        name,
        params: [],
        returnType: "u32" as const,
        // The process stops inside the call, so no cleanup contract is ever exercised.
        callingConvention: "cdecl" as const,
    })),
};
