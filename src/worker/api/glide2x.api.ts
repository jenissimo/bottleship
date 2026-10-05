/**
 * Glide 2.x API Descriptor (glide2x.dll / 3dfx_win.bdd dependency)
 *
 * Used by HLE Glide backend with full export coverage for Glide 2.4+ style calls.
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    ...overrides,
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const glide2xModule: ModuleDescriptor = {
    name: "glide2x",
    functions: [
        // Init / shutdown
        makeFunc("_grGlideInit@0", 0),
        makeFunc("_grGlideShutdown@0", 0),
        makeFunc("_grGlideGetVersion@4", 1),        // char* version_string
        makeFunc("_grGlideGetState@4", 1),           // GrState* state
        makeFunc("_grGlideSetState@4", 1),           // const GrState* state

        // Hardware query / selection
        makeFunc("_grSstQueryHardware@4", 1),        // GrHwConfiguration* hwconfig -> FX_TRUE
        makeFunc("_grSstQueryBoards@4", 1),          // GrHwConfiguration* hwconfig
        makeFunc("_grSstSelect@4", 1),               // int which_sst
        makeFunc("_grSstWinOpen@28", 7),             // HWND, res, refresh, colorFmt, origin, nColBuf, nAuxBuf -> FX_TRUE
        makeFunc("_grSstWinClose@0", 0),
        makeFunc("_grSstIdle@0", 0),
        makeFunc("_grSstStatus@0", 0),
        makeFunc("_grSstControl@4", 1),              // GR_CONTROL_ACTIVATE/DEACTIVATE -> FX_TRUE
        makeFunc("_grSstPerformSelfTest@0", 0),
        makeFunc("_grSstQueryMemory@8", 2),          // FxU32* fbRam, FxU32* texRam
        makeFunc("_grSstScreenWidth@0", 0),          // FxU32 — resolution grSstWinOpen gave us
        makeFunc("_grSstScreenHeight@0", 0),         // FxU32
        makeFunc("_grSstIsBusy@0", 0),               // FxBool — FIFO backlog (never, we are synchronous)
        makeFunc("_grSstVRetraceOn@0", 0),           // FxBool — inside vertical retrace
        makeFunc("_grDisableAllEffects@0", 0),

        // Error / callback
        makeFunc("_grErrorSetCallback@4", 1),        // GrErrorCallbackFnc_t fnc

        // Buffer control
        makeFunc("_grBufferSwap@4", 1),              // int swap_interval
        makeFunc("_grBufferClear@12", 3),            // GrColor_t color, GrAlpha_t alpha, FxU16 depth
        makeFunc("_grBufferNumPending@0", 0),
        makeFunc("_grRenderBuffer@4", 1),            // GrBuffer_t buffer

        // Linear frame buffer
        makeFunc("_grLfbLock@24", 6),               // type, buf, writeMode, origin, pixelPipeline, info -> FX_TRUE
        makeFunc("_grLfbUnlock@8", 2),               // type, buffer -> FX_TRUE
        makeFunc("_grLfbConstantAlpha@4", 1),        // GrAlpha_t
        makeFunc("_grLfbConstantDepth@4", 1),        // FxU32 depth
        makeFunc("_grLfbWriteColorFormat@4", 1),     // GrColorFormat_t
        makeFunc("_grLfbWriteColorSwizzle@8", 2),    // FxBool swizzleBytes, FxBool swapWords
        // grLfbReadRegion(src_buffer, src_x, src_y, src_width, src_height, dst_stride, dst_data)
        // = 7 args = @28 (was wrongly @24/6 → 4-byte stdcall stack imbalance every call).
        makeFunc("_grLfbReadRegion@28", 7),
        makeFunc("_grLfbWriteRegion@32", 8),

        // Texture management
        makeFunc("_grTexCombine@28", 7),             // tmu, rgbFn, rgbFac, aFn, aFac, rgbInv, aInv
        makeFunc("_guTexCombineFunction@8", 2),      // tmu, GrTextureCombineFnc_t
        makeFunc("_grTexMinAddress@4", 1),           // GrChipID_t tmu -> 0
        makeFunc("_grTexMaxAddress@4", 1),           // GrChipID_t tmu -> 0
        makeFunc("_grTexTextureMemRequired@8", 2),   // evenOdd, GrTexInfo* -> bytes
        makeFunc("_grTexSource@16", 4),
        makeFunc("_guTexSource@4", 1),
        makeFunc("_grTexDownloadMipMap@16", 4),
        makeFunc("_grTexDownloadTable@12", 3),
        makeFunc("_grTexClampMode@12", 3),
        makeFunc("_grTexFilterMode@12", 3),
        makeFunc("_grTexMipMapMode@12", 3),
        makeFunc("_grTexLodBiasValue@8", 2),
        makeFunc("_grTexNCCTable@8", 2),
        makeFunc("_grTexMultibase@8", 2),
        makeFunc("_grTexBaseAddress@8", 2),
        makeFunc("_grTexCombineFunction@8", 2),
        makeFunc("_grTexDetailControl@16", 4),

        // Color / alpha combine
        makeFunc("_grColorCombine@20", 5),
        makeFunc("_guColorCombineFunction@4", 1),
        makeFunc("_grAlphaCombine@20", 5),
        makeFunc("_grAlphaBlendFunction@16", 4),
        makeFunc("_grAlphaTestFunction@4", 1),
        makeFunc("_grAlphaTestReferenceValue@4", 1),
        makeFunc("_guAlphaSource@4", 1),              // GrAlphaSource_t preset
        makeFunc("_grAlphaControlsITRGBLighting@4", 1),

        // Fog (real names are gu*; gr* kept as harmless aliases)
        makeFunc("_grFogMode@4", 1),
        makeFunc("_grFogColorValue@4", 1),
        makeFunc("_grFogTable@4", 1),
        makeFunc("_grFogGenerateExp@8", 2),
        makeFunc("_grFogGenerateExp2@8", 2),
        makeFunc("_grFogGenerateLinear@12", 3),
        makeFunc("_guFogGenerateExp@8", 2),
        makeFunc("_guFogGenerateExp2@8", 2),
        makeFunc("_guFogGenerateLinear@12", 3),

        // Depth / stencil
        makeFunc("_grDepthBiasLevel@4", 1),
        makeFunc("_grDepthBufferFunction@4", 1),
        makeFunc("_grDepthBufferMode@4", 1),
        makeFunc("_grDepthMask@4", 1),

        // Clipping / viewport
        makeFunc("_grClipWindow@16", 4),
        makeFunc("_grViewport@16", 4),
        makeFunc("_grSstOrigin@4", 1),

        // Drawing
        makeFunc("_grDrawPoint@4", 1),
        makeFunc("_grDrawLine@8", 2),
        makeFunc("_grDrawTriangle@12", 3),
        makeFunc("_grDrawPlanarPolygon@12", 3),
        makeFunc("_grDrawPlanarPolygonVertexList@8", 2),
        makeFunc("_grDrawPolygon@12", 3),
        makeFunc("_grDrawPolygonVertexList@8", 2),

        // Misc state
        makeFunc("_grColorMask@8", 2),
        makeFunc("_grCullMode@4", 1),
        makeFunc("_grDitherMode@4", 1),
        makeFunc("_grChromakeyMode@4", 1),
        makeFunc("_grChromakeyValue@4", 1),
        makeFunc("_grConstantColorValue@4", 1),
        makeFunc("_grConstantColorValue4@16", 4),
        makeFunc("_grGammaCorrectionValue@4", 1),
        makeFunc("_grHints@8", 2),

        // Display
        makeFunc("_grSplash@20", 5),
        makeFunc("_grAADrawLine@8", 2),
        makeFunc("_grAADrawPoint@4", 1),
        makeFunc("_grAADrawPolygon@12", 3),
        makeFunc("_grAADrawPolygonVertexList@8", 2),
        // grAADrawTriangle(a, b, c, ab_aa, bc_aa, ca_aa) = 6 args = @24 (was wrongly @20/5).
        makeFunc("_grAADrawTriangle@24", 6),
    ]
};

