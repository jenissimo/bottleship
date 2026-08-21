/**
 * Shared types for D3D module
 */
import { ThunkImplementation } from "../../../core/thunking/thunk-dispatcher";
import { DDrawContext } from "../context";
import type { DirectDrawSurfaceObject, DirectDrawSurfaceState } from "../com-objects";

export type D3DExports = Record<string, ThunkImplementation>;

// ============================================================================
// D3D7 Lighting Data Structures
// ============================================================================

/**
 * D3DCOLORVALUE - RGBA color with floats (matches D3DCOLORVALUE structure)
 */
export interface D3DColorValue {
    r: number;  // Red (0.0 - 1.0)
    g: number;  // Green (0.0 - 1.0)
    b: number;  // Blue (0.0 - 1.0)
    a: number;  // Alpha (0.0 - 1.0)
}

/**
 * D3DVECTOR - 3D vector (matches D3DVECTOR structure)
 */
export interface D3DVector {
    x: number;
    y: number;
    z: number;
}

/**
 * D3DMATERIAL7 - Material properties for lighting calculations
 */
export interface D3DMaterial7Data {
    diffuse: D3DColorValue;   // Diffuse color
    ambient: D3DColorValue;   // Ambient color
    specular: D3DColorValue;  // Specular color
    emissive: D3DColorValue;  // Emissive color (self-illumination)
    power: number;            // Specular power (shininess)
}

/**
 * D3DLIGHT7 - Light source properties
 */
export interface D3DLight7Data {
    type: number;             // D3DLIGHT_POINT, D3DLIGHT_SPOT, or D3DLIGHT_DIRECTIONAL
    diffuse: D3DColorValue;   // Diffuse color contribution
    specular: D3DColorValue;  // Specular color contribution
    ambient: D3DColorValue;   // Ambient color contribution
    position: D3DVector;      // Position in world space (point/spot)
    direction: D3DVector;     // Direction in world space (directional/spot)
    range: number;            // Cutoff range
    falloff: number;          // Spot falloff factor
    attenuation0: number;     // Constant attenuation
    attenuation1: number;     // Linear attenuation
    attenuation2: number;     // Quadratic attenuation
    theta: number;            // Spot inner cone angle (radians)
    phi: number;              // Spot outer cone angle (radians)
}

/**
 * Create default material (white diffuse, no specular, no emissive)
 */
export function createDefaultMaterial(): D3DMaterial7Data {
    return {
        diffuse: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
        ambient: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
        specular: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
        emissive: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
        power: 0.0,
    };
}

/**
 * Create default light (disabled white directional light)
 */
export function createDefaultLight(): D3DLight7Data {
    return {
        type: 3, // D3DLIGHT_DIRECTIONAL
        diffuse: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
        specular: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
        ambient: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
        position: { x: 0.0, y: 0.0, z: 0.0 },
        direction: { x: 0.0, y: 0.0, z: 1.0 },
        range: 0.0,
        falloff: 1.0,
        attenuation0: 1.0,
        attenuation1: 0.0,
        attenuation2: 0.0,
        theta: 0.0,
        phi: 0.0,
    };
}

// ============================================================================
// D3D7 State Block System
// ============================================================================

/**
 * D3DStateBlock - Saved device state for BeginStateBlock/EndStateBlock/ApplyStateBlock
 */
export interface D3DStateBlock {
    id: number;                              // Unique state block handle
    renderStates: Int32Array;                // Copy of 256 render states
    textureStageStates: Int32Array;          // Copy of 8*32 texture stage states
    textures: number[];                      // 8 texture handles (interface addresses)
    transforms: {
        world: Float32Array | null;
        view: Float32Array | null;
        projection: Float32Array | null;
    };
    material: D3DMaterial7Data | null;       // Material state
    lights: Map<number, D3DLight7Data>;      // Light configurations
    lightsEnabled: Set<number>;              // Set of enabled light indices
    viewport: {
        x: number;
        y: number;
        width: number;
        height: number;
        minZ: number;
        maxZ: number;
    } | null;
}

export interface TextureResolution {
    addr: number;
    obj: DirectDrawSurfaceObject | null;
    source: string;
    textureHandleEntry?: TextureHandleEntry;
}

export interface TextureHandleEntry {
    handle: number;
    width: number;
    height: number;
    pitch: number;
    format: { flags?: number; bpp: number; rMask: number; gMask: number; bMask: number; aMask: number };
    gpuTexture: GPUTexture | null;
    gpuTextureView: GPUTextureView | null;
    gpuTextureFormat?: GPUTextureFormat;
    /** CPU-First: Surface mode and dirty tracking */
    mode?: "CPU" | "GPU_ONLY";
    version?: number;
    lastUploadVersion?: number;
    srcColorKey?: { low: number; high: number };
    surfaceState?: DirectDrawSurfaceState;
}

export interface TextureManager {
    resolve: (ptrOrHandle: number) => TextureResolution;
    resolveToSurface: (interfaceAddr: number) => DirectDrawSurfaceObject | null;
    registerPersistent: (surfaceObj: DirectDrawSurfaceObject) => void;
    setDeviceTexture: (deviceObj: any, stage: number, textureId: number) => void;
}

export interface DrawHandler {
    handleDrawPrimitive: (
        devicePtr: number,
        type: number,
        vtype: number,
        lpVertices: number,
        count: number,
        mem: Uint8Array,
        isIndexed?: boolean,
        lpIndices?: number,
        iCount?: number
    ) => void;
}

// Re-export common constants
export const D3D_OK = 0x00000000;
export const D3DERR_INVALIDCALL = 0x8876086c;

// Import constants for default state initialization
import {
    D3DRENDERSTATE_ZENABLE,
    D3DRENDERSTATE_FILLMODE,
    D3DRENDERSTATE_SHADEMODE,
    D3DRENDERSTATE_ZWRITEENABLE,
    D3DRENDERSTATE_ALPHATESTENABLE,
    D3DRENDERSTATE_SRCBLEND,
    D3DRENDERSTATE_DESTBLEND,
    D3DRENDERSTATE_CULLMODE,
    D3DRENDERSTATE_ZFUNC,
    D3DRENDERSTATE_ALPHAREF,
    D3DRENDERSTATE_ALPHAFUNC,
    D3DRENDERSTATE_DITHERENABLE,
    D3DRENDERSTATE_ALPHABLENDENABLE,
    D3DRENDERSTATE_FOGENABLE,
    D3DRENDERSTATE_FOGTABLEMODE,
    D3DRENDERSTATE_FOGVERTEXMODE,
    D3DRENDERSTATE_FOGSTART,
    D3DRENDERSTATE_FOGEND,
    D3DRENDERSTATE_FOGDENSITY,
    D3DRENDERSTATE_SPECULARENABLE,
    D3DRENDERSTATE_COLORKEYENABLE,
    D3DRENDERSTATE_LIGHTING,
    D3DRENDERSTATE_AMBIENT,
    D3DRENDERSTATE_TEXTUREFACTOR,
    D3DRENDERSTATE_COLORVERTEX,
    D3DRENDERSTATE_LOCALVIEWER,
    D3DRENDERSTATE_DIFFUSEMATERIALSOURCE,
    D3DRENDERSTATE_AMBIENTMATERIALSOURCE,
    D3DRENDERSTATE_SPECULARMATERIALSOURCE,
    D3DRENDERSTATE_EMISSIVEMATERIALSOURCE,
    D3DZB_TRUE,
    D3DFILL_SOLID,
    D3DSHADE_GOURAUD,
    D3DCULL_CCW,
    D3DCMP_LESSEQUAL,
    D3DCMP_ALWAYS,
    D3DBLEND_ONE,
    D3DBLEND_ZERO,
    D3DTSS_COLOROP,
    D3DTSS_COLORARG1,
    D3DTSS_COLORARG2,
    D3DTSS_ALPHAOP,
    D3DTSS_ALPHAARG1,
    D3DTSS_ALPHAARG2,
    D3DTSS_TEXCOORDINDEX,
    D3DTSS_ADDRESSU,
    D3DTSS_ADDRESSV,
    D3DTA_DIFFUSE,
    D3DTSS_MINFILTER,
    D3DTSS_MAGFILTER,
    D3DTSS_MIPFILTER,
    D3DTOP_DISABLE,
    D3DTOP_SELECTARG1,
    D3DTOP_MODULATE,
    D3DTA_TEXTURE,
    D3DTA_CURRENT,
    D3DTADDRESS_WRAP,
    D3DTFN_POINT,
    D3DTFG_POINT,
    D3DTFP_NONE,
    D3DZB_FALSE,
} from '../constants';

/**
 * Create default render states with valid D3D7 enum values.
 * 
 * Do not leave states uninitialized. For enums where 0 is invalid,
 * explicitly set a valid default. However, note that 0 IS valid for some states:
 * - D3DTA_DIFFUSE = 0 (valid texture argument)
 * - D3DZB_FALSE = 0 (valid Z-buffer disable)
 * - ALPHAREF = 0 (valid reference value)
 * - AMBIENT = 0 (valid black ambient)
 * 
 * This prevents black screens, disappearing geometry, and broken depth testing.
 */
function createDefaultRenderStates(): Int32Array {
    const rs = new Int32Array(256);

    // --- Critical defaults for Z-Buffer ---
    // Z-buffer disabled by default (games will enable if needed)
    // ZWRITEENABLE can be TRUE even when ZENABLE is FALSE (DX7 behavior)
    // NOTE: Depth attachment is created only when ZENABLE is true (see pipeline-factory.ts)
    rs[D3DRENDERSTATE_ZENABLE] = D3DZB_FALSE; // 0 (disabled by default, valid value)
    rs[D3DRENDERSTATE_ZWRITEENABLE] = 1; // TRUE
    rs[D3DRENDERSTATE_ZFUNC] = D3DCMP_LESSEQUAL; // 4 (0 would be invalid, but not used when ZENABLE=false)

    // --- Rasterization defaults ---
    rs[D3DRENDERSTATE_FILLMODE] = D3DFILL_SOLID; // 3 (0 is invalid!)
    rs[D3DRENDERSTATE_SHADEMODE] = D3DSHADE_GOURAUD; // 2
    rs[D3DRENDERSTATE_CULLMODE] = D3DCULL_CCW; // 3 (Backface culling, 0 is invalid!)

    // --- Alpha test and blending (disabled by default) ---
    rs[D3DRENDERSTATE_ALPHATESTENABLE] = 0; // FALSE
    rs[D3DRENDERSTATE_ALPHAREF] = 0; // Valid reference value (0..255)
    rs[D3DRENDERSTATE_ALPHAFUNC] = D3DCMP_ALWAYS; // 8 (0 is invalid!)

    rs[D3DRENDERSTATE_ALPHABLENDENABLE] = 0; // FALSE
    rs[D3DRENDERSTATE_SRCBLEND] = D3DBLEND_ONE; // 2 (D3D7 default: ONE)
    rs[D3DRENDERSTATE_DESTBLEND] = D3DBLEND_ZERO; // 1 (D3D7 default: ZERO)

    // --- Lighting (DISABLED until fully implemented) ---
    // D3D7 API default is LIGHTING=TRUE, but our emulator doesn't implement:
    // - SetMaterial (diffuse/specular/emissive properties)
    // - SetLight (directional/point/spot lights)
    // - LightEnable (per-light enable/disable)
    // - Vertex normal transformation for light calculations
    //
    // With LIGHTING=TRUE and no lights configured, D3D would produce black models.
    // Games that rely on lighting typically set ambient or add lights explicitly.
    // Until full lighting is implemented, we default to LIGHTING=FALSE so that
    // vertex diffuse colors pass through unmodified (equivalent to unlit rendering).
    rs[D3DRENDERSTATE_LIGHTING] = 0; // FALSE (disabled until SetMaterial/SetLight implemented)
    rs[D3DRENDERSTATE_AMBIENT] = 0; // 0x00000000 (Black ambient, valid value)
    rs[D3DRENDERSTATE_SPECULARENABLE] = 0; // FALSE

    // --- Other states (disabled by default) ---
    rs[D3DRENDERSTATE_DITHERENABLE] = 0; // FALSE
    rs[D3DRENDERSTATE_FOGENABLE] = 0; // FALSE
    rs[D3DRENDERSTATE_FOGTABLEMODE] = 0; // D3DFOG_NONE
    rs[D3DRENDERSTATE_FOGVERTEXMODE] = 0; // D3DFOG_NONE
    // Fog params are float-as-DWORD render states. D3D defaults: start=0.0, end=1.0,
    // density=1.0. Raw 0 for FOGSTART is the true default (0.0f); END/DENSITY must
    // carry 1.0f bits so the executor can trust raw values without special-casing 0.
    rs[D3DRENDERSTATE_FOGSTART] = 0x00000000;  // 0.0f
    rs[D3DRENDERSTATE_FOGEND] = 0x3F800000;    // 1.0f
    rs[D3DRENDERSTATE_FOGDENSITY] = 0x3F800000; // 1.0f
    rs[D3DRENDERSTATE_COLORKEYENABLE] = 0; // FALSE
    // D3DRENDERSTATE_TEXTUREFACTOR default is opaque white (0xFFFFFFFF)
    // Needed for pipelines that modulate with TFACTOR without explicitly setting it.
    rs[D3DRENDERSTATE_TEXTUREFACTOR] = 0xFFFFFFFF;

    // --- FFP lighting colour sources (DX7 defaults) ---
    // COLORVERTEX/LOCALVIEWER default TRUE; DIFFUSE=COLOR1, SPECULAR=COLOR2,
    // AMBIENT/EMISSIVE=MATERIAL. An Int32Array reads 0 for unseeded slots, and the
    // executor's source resolution treats COLORVERTEX=0 as an explicit FALSE, collapsing
    // every source to MATERIAL — lit vertex-colored geometry then renders with the white
    // default material instead of its vertex colors (falsy-zero, same class as FOGEND).
    rs[D3DRENDERSTATE_COLORVERTEX] = 1;   // TRUE
    rs[D3DRENDERSTATE_LOCALVIEWER] = 1;   // TRUE
    rs[D3DRENDERSTATE_DIFFUSEMATERIALSOURCE] = 1;  // D3DMCS_COLOR1
    rs[D3DRENDERSTATE_AMBIENTMATERIALSOURCE] = 0;  // D3DMCS_MATERIAL
    rs[D3DRENDERSTATE_SPECULARMATERIALSOURCE] = 2; // D3DMCS_COLOR2
    rs[D3DRENDERSTATE_EMISSIVEMATERIALSOURCE] = 0; // D3DMCS_MATERIAL

    // --- States above the D3D7 enum that the shared FFP pipeline still reads ---
    // The D3D7 render-state enum stops at 152, but the pipeline factory is shared with D3D8
    // and consults COLORWRITEENABLE and BLENDOP. Both have a falsy-zero trap: 0 is a LEGAL
    // COLORWRITEENABLE meaning "write no channel at all", so an unseeded slot reads as a
    // legitimate instruction to blacken every title that never touches the state, and 0 is
    // not a valid D3DBLENDOP at all. Seed the API defaults, as d3d9-state-tracker does.
    const D3DRS_COLORWRITEENABLE = 168, D3DRS_BLENDOP = 171;
    const ALL_CHANNELS = 0xf, D3DBLENDOP_ADD = 1;
    rs[D3DRS_COLORWRITEENABLE] = ALL_CHANNELS;
    rs[D3DRS_BLENDOP] = D3DBLENDOP_ADD;

    // The stencil masks are the same trap one enum lower: 0 is a legal mask meaning "no
    // bits", so a title that enables stencil without setting them would test against nothing
    // and write nothing. The pipeline's `?? 0xff` cannot rescue it — an Int32Array element is
    // never undefined, so the fallback is dead code and the seed is the only defence. All
    // bits of the stencil8 attachment we actually allocate is 0xff.
    const D3DRS_STENCILMASK = 58, D3DRS_STENCILWRITEMASK = 59, ALL_STENCIL_BITS = 0xff;
    rs[D3DRS_STENCILMASK] = ALL_STENCIL_BITS;
    rs[D3DRS_STENCILWRITEMASK] = ALL_STENCIL_BITS;

    return rs;
}

export const EMPTY_RENDER_STATES = createDefaultRenderStates();

/**
 * Initialize texture stage states with D3D7 default values.
 * Includes sampling parameters (address modes, filters) which must not be zero.
 * 
 * NOTE: On stage 0, CURRENT == DIFFUSE (no previous stage output), so D3DTA_DIFFUSE and D3DTA_CURRENT
 * are equivalent. We use D3DTA_DIFFUSE for clarity, but CURRENT would work the same.
 * 
 * TextureState->Uniform packing must be consistent:
 * - Stage 0: texStates[0*32 + stateId] -> uniforms.colorArg1/colorArg2/alphaArg1/alphaArg2
 * - Stage 1: texStates[1*32 + stateId] -> uniforms.colorArg1_1/colorArg2_1/alphaArg1_1/alphaArg2_1
 * If indices are swapped or wrong stateId is used, you'll get bugs like "missing progress bar" or "wrong alpha source".
 * See ddraw-backend-executor.ts prepareDraw() for the mapping logic.
 */
function createDefaultTexStates(): Int32Array {
    const states = new Int32Array(8 * 32);

    // Stage 0: MODULATE texture with diffuse, alpha from texture
    // 
    // COLORARG2: Using D3DTA_DIFFUSE (0) on stage 0. In D3D7 docs, CURRENT is often mentioned as default,
    // but on stage 0 CURRENT resolves to DIFFUSE (no previous stage). Both are equivalent here.
    // If lighting is not fully implemented, ensure CURRENT starts as lit diffuse for consistency.
    //
    // ALPHAARG1: Must be D3DTA_TEXTURE for alpha test/blending to work correctly.
    // If texture is missing, executor fallback replaces TEXTURE args with DIFFUSE (see ddraw-backend-executor.ts).
    // Shader should handle missing texture gracefully (texAlpha = 1.0 or diffuse.a fallback).
    states[0 * 32 + D3DTSS_COLOROP] = D3DTOP_MODULATE; // 4
    states[0 * 32 + D3DTSS_COLORARG1] = D3DTA_TEXTURE; // 2
    states[0 * 32 + D3DTSS_COLORARG2] = D3DTA_DIFFUSE; // 0 (valid value! On stage0, equivalent to CURRENT)
    // Default AlphaOp for Stage 0 is SELECTARG1 in D3D7.
    // Using MODULATE causes invisible geometry if input vertex alpha is 0.
    // SELECTARG1 takes only texture alpha, ignoring vertex alpha (unless explicitly modulated later).
    states[0 * 32 + D3DTSS_ALPHAOP] = D3DTOP_SELECTARG1; // 2 (Correct D3D7 default for stage 0)
    states[0 * 32 + D3DTSS_ALPHAARG1] = D3DTA_TEXTURE; // 2
    states[0 * 32 + D3DTSS_ALPHAARG2] = D3DTA_DIFFUSE; // 0 (diffuse alpha, unused with SELECTARG1 but set for consistency)

    // Apply sampling defaults to all stages (especially Stage 0)
    // D3D7 defaults: WRAP addressing, POINT filtering, NO mipmap filtering
    // NOTE: D3DTFP_NONE = 1 (not 0), so this is valid
    for (let stage = 0; stage < 8; stage++) {
        const offset = stage * 32;

        // Address modes (WRAP is default, value = 1)
        states[offset + D3DTSS_ADDRESSU] = D3DTADDRESS_WRAP; // 1
        states[offset + D3DTSS_ADDRESSV] = D3DTADDRESS_WRAP; // 1
        states[offset + D3DTSS_TEXCOORDINDEX] = stage;

        // Filters (POINT is default, values = 1)
        states[offset + D3DTSS_MINFILTER] = D3DTFN_POINT; // 1
        states[offset + D3DTSS_MAGFILTER] = D3DTFG_POINT; // 1
        states[offset + D3DTSS_MIPFILTER] = D3DTFP_NONE; // 1 (valid value, not 0)

        // Stages 1-7: DISABLE operations by default
        if (stage > 0) {
            states[offset + D3DTSS_COLOROP] = D3DTOP_DISABLE; // 1
            states[offset + D3DTSS_ALPHAOP] = D3DTOP_DISABLE; // 1
        }
    }

    return states;
}

export const EMPTY_TEX_STATES = createDefaultTexStates();
