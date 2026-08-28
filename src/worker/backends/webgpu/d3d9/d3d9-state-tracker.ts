/**
 * D3D9StateTracker - Manages render state, transforms, and stream bindings
 *
 * Separated from D3D9Device to follow single-responsibility principle
 * and enable cleaner state management.
 */

import type { StreamBindingTable } from "../shared/vertex-streams";

const D3DRS_LIGHTING = 137;
const D3DRS_CULLMODE = 22;
const D3DRS_ZENABLE = 7;
const D3DRS_ZWRITEENABLE = 14;

const D3DTS_WORLD = 0x100;
/** D3DTS_WORLDMATRIX(i) is D3DTS_WORLD + i. The FFP path supports four
 * non-indexed matrices and an eight-entry indexed palette. */
export const FFP_WORLD_MATRIX_COUNT = 8;
const D3DTS_VIEW = 2;
const D3DTS_PROJECTION = 3;
// D3DTS_TEXTURE0..7 — the fixed-function per-stage texture matrix (D3DTSS_TEXTURETRANSFORMFLAGS
// says how many of its output components a stage consumes).
const D3DTS_TEXTURE0 = 16;
export const FFP_TEXTURE_TRANSFORM_COUNT = 8;

/** D3D9's texture-stage namespace is sparse: pixel samplers occupy 0..15 while
 * vertex texture samplers occupy 257..260. Keep the storage windows adjacent
 * internally without ever accepting the invalid API gap between them. */
export const D3D9_PIXEL_TEXTURE_STAGE_COUNT = 16;
/** D3DTSS_* state is defined for the eight fixed-function texture stages. */
export const D3D9_FFP_STAGE_COUNT = 8;
export const D3D9_VERTEX_TEXTURE_SAMPLER_BASE = 257;
export const D3D9_VERTEX_TEXTURE_SAMPLER_COUNT = 4;
/** D3DDMAPSAMPLER — the displacement map for presampled N-patch/RT-patch tessellation.
 *  SetTexture(256, ...) is a legal call and must succeed; no draw path samples the slot,
 *  because the tessellator does not consume a displacement map. */
export const D3D9_DMAP_SAMPLER = 256;
export const D3D9_TEXTURE_SLOT_COUNT =
    D3D9_PIXEL_TEXTURE_STAGE_COUNT + D3D9_VERTEX_TEXTURE_SAMPLER_COUNT + 1;
const D3D9_DMAP_SLOT = D3D9_PIXEL_TEXTURE_STAGE_COUNT + D3D9_VERTEX_TEXTURE_SAMPLER_COUNT;

export function d3d9TextureStageSlot(stage: number): number {
    // Guest ABI values are uint32s.  Keep the helper strict when called from
    // JS-facing/state-block paths too: NaN and fractional values must not
    // truncate to stage 0 through the unsigned shift below.
    if (!Number.isInteger(stage) || stage < 0 || stage > 0xffffffff) return -1;
    const s = stage >>> 0;
    if (s < D3D9_PIXEL_TEXTURE_STAGE_COUNT) return s;
    if (s >= D3D9_VERTEX_TEXTURE_SAMPLER_BASE
        && s < D3D9_VERTEX_TEXTURE_SAMPLER_BASE + D3D9_VERTEX_TEXTURE_SAMPLER_COUNT) {
        return D3D9_PIXEL_TEXTURE_STAGE_COUNT + s - D3D9_VERTEX_TEXTURE_SAMPLER_BASE;
    }
    if (s === D3D9_DMAP_SAMPLER) return D3D9_DMAP_SLOT;
    return -1;
}

export function isD3D9TextureStage(stage: number): boolean {
    return d3d9TextureStageSlot(stage) >= 0;
}

/** A read-only view of one slot of the stream binding table. */
export interface StreamSource {
    readonly index: number;
    readonly offset: number;
    readonly stride: number;
}

export interface DirtyFlags {
    renderStates: boolean;
    transforms: boolean;
    fvf: boolean;
    streams: boolean;
    textures: boolean;
}

export class D3D9StateTracker {
    // Render states
    private renderStates: Int32Array = new Int32Array(256);

    // Transforms
    private worldMatrix: Float32Array;
    /** D3DTS_WORLDMATRIX(0..7), kept separately so palette entries survive while
     * the ordinary WORLD transform remains the fast/common path. Entry 0 mirrors
     * worldMatrix (D3DTS_WORLD == D3DTS_WORLDMATRIX(0)). */
    private worldMatrices = new Float32Array(FFP_WORLD_MATRIX_COUNT * 16);
    private viewMatrix: Float32Array;
    private projMatrix: Float32Array;
    /** D3DTS_TEXTURE0..7, one 4×4 each in a single flat array (stage N at N*16). */
    private texMatrices = new Float32Array(FFP_TEXTURE_TRANSFORM_COUNT * 16);

    // FVF and stream bindings
    private fvf: number = 0;
    private indexSource: number | null = null;
    /** Read-through view onto slot 0 of the binding table (see getStreamSource) — one object,
     *  reused, so the per-draw reads that use it allocate nothing. */
    private readonly stream0View: StreamSource;

    // Texture stages
    private textureStages: (number | null)[] = new Array(D3D9_TEXTURE_SLOT_COUNT).fill(null);

    // Dirty tracking
    private dirtyFlags: DirtyFlags = {
        renderStates: true,
        transforms: true,
        fvf: true,
        streams: true,
        textures: true,
    };

    // Cached pipeline key
    private pipelineKey: number | null = null;
    private pipelineKeyDirty = true;

    // Performance metrics
    public metrics = {
        pipelineChanges: 0,
        bindGroupChanges: 0,
        stateUpdates: 0,
        textureChanges: 0,
        transformUpdates: 0,
    };

    /** `streams` is the device's binding table — the tracker READS it, never writes it. */
    constructor(private readonly streams: StreamBindingTable) {
        const table = streams;
        this.stream0View = {
            get index(): number { return table.bufferIndex[0]!; },
            get offset(): number { return table.offsetBytes[0]!; },
            get stride(): number { return table.strideBytes[0]!; },
        };
        this.worldMatrix = identityMatrix();
        for (let i = 0; i < FFP_WORLD_MATRIX_COUNT; i++) this.worldMatrices.set(this.worldMatrix, i * 16);
        this.viewMatrix = identityMatrix();
        this.projMatrix = identityMatrix();
        this.resetTexMatrices();
        this.seedRenderStateDefaults();
    }

    private resetTexMatrices(): void {
        this.texMatrices.fill(0);
        for (let s = 0; s < FFP_TEXTURE_TRANSFORM_COUNT; s++) {
            const b = s * 16;
            this.texMatrices[b] = 1;
            this.texMatrices[b + 5] = 1;
            this.texMatrices[b + 10] = 1;
            this.texMatrices[b + 15] = 1;
        }
    }

    /**
     * Seed the non-zero D3D9 default render states the blend/lighting pipelines depend on.
     * The render-state array is zero-filled, but several defaults are non-zero (notably
     * COLORWRITEENABLE = all channels, the FFP material-colour sources, and the depth states).
     *
     * This runs on Reset() too, which is the case that matters most: after a real D3D9 Reset
     * every render state returns to its default, and a game that relied on one before the Reset
     * has no reason to set it again.
     */
    private seedRenderStateDefaults(): void {
        const D3DBLEND_ONE = 2, D3DBLEND_ZERO = 1, D3DBLENDOP_ADD = 1, ALL_CHANNELS = 0xf;
        this.renderStates[19] = D3DBLEND_ONE;    // D3DRS_SRCBLEND
        this.renderStates[20] = D3DBLEND_ZERO;   // D3DRS_DESTBLEND
        this.renderStates[171] = D3DBLENDOP_ADD; // D3DRS_BLENDOP
        this.renderStates[207] = D3DBLEND_ONE;   // D3DRS_SRCBLENDALPHA
        this.renderStates[208] = D3DBLEND_ZERO;  // D3DRS_DESTBLENDALPHA
        this.renderStates[209] = D3DBLENDOP_ADD; // D3DRS_BLENDOPALPHA
        this.renderStates[168] = ALL_CHANNELS;   // D3DRS_COLORWRITEENABLE
        this.renderStates[190] = ALL_CHANNELS;   // D3DRS_COLORWRITEENABLE1
        this.renderStates[60] = 0xFFFFFFFF;      // D3DRS_TEXTUREFACTOR (opaque white)
        this.renderStates[191] = ALL_CHANNELS;   // D3DRS_COLORWRITEENABLE2
        this.renderStates[192] = ALL_CHANNELS;   // D3DRS_COLORWRITEENABLE3
        // FFP lighting defaults (D3DMCS_*: MATERIAL=0, COLOR1=1, COLOR2=2). These let
        // unset values reflect the real D3D defaults so an explicit MATERIAL (0) is
        // distinguishable from "never set".
        // D3DRS_LIGHTING defaults to TRUE, and the material defaults to all-zero, so an app that
        // never touches either draws black — that is real D3D9, not a gap. Seeding FALSE instead
        // would make every app that relies on the default (or on Reset restoring it) render
        // full-bright unlit, and no app can detect the difference to work around it.
        // The D3D8 adapter deliberately seeds FALSE instead; see the note at its own seed.
        this.renderStates[137] = 1;  // D3DRS_LIGHTING           = TRUE
        this.renderStates[141] = 1;  // D3DRS_COLORVERTEX        = TRUE
        this.renderStates[142] = 1;  // D3DRS_LOCALVIEWER        = TRUE
        this.renderStates[145] = 1;  // D3DRS_DIFFUSEMATERIALSOURCE  = D3DMCS_COLOR1
        this.renderStates[146] = 2;  // D3DRS_SPECULARMATERIALSOURCE = D3DMCS_COLOR2
        // D3DRS_AMBIENTMATERIALSOURCE (147) / EMISSIVEMATERIALSOURCE (148) default to MATERIAL = 0.
        // Point-sprite size render states are FLOATS bit-cast into the DWORD. Seed the D3D
        // defaults so an explicit 0.0f (points suppressed / no lower clamp) is distinguishable
        // from "never set" — the point-sprite path reads these directly via rsFloat.
        this.renderStates[154] = 0x3F800000; // D3DRS_POINTSIZE     = 1.0f
        this.renderStates[155] = 0x3F800000; // D3DRS_POINTSIZE_MIN = 1.0f
        this.renderStates[166] = 0x46000000; // D3DRS_POINTSIZE_MAX = 8192.0f (advertised MaxPointSize)
        // D3DRS_POINTSCALE_A defaults to 1.0f (B/C default to 0.0f, which the Int32Array's own
        // zero already gives correctly). Leaving A unseeded reads 0.0f instead, and the
        // attenuation formula is size/sqrt(A+B·De+C·De²) — a title that enables
        // POINTSCALEENABLE without setting all three constants divides by zero.
        this.renderStates[158] = 0x3F800000; // D3DRS_POINTSCALE_A = 1.0f
        // Multisample defaults: all samples enabled, antialiasing and antialiased lines off.
        // Keeping the mask explicit matters because an Int32Array's zero value would otherwise
        // turn every default single-sample draw into an accidental "discard all samples" state.
        this.renderStates[161] = 1;          // D3DRS_MULTISAMPLEANTIALIAS = TRUE
        this.renderStates[162] = 0xffffffff; // D3DRS_MULTISAMPLEMASK = all samples
        this.renderStates[176] = 0;          // D3DRS_ANTIALIASEDLINEENABLE = FALSE
        // Depth. D3DRS_ZENABLE defaults to D3DZB_TRUE when the device has an automatic
        // depth-stencil buffer, which ours always does (every pipeline carries a
        // depth24plus-stencil8 attachment). These MUST be seeded rather than inferred at the
        // read site: renderStates
        // is an Int32Array, so an unset entry reads 0, not undefined, and a `?? 1` fallback can
        // never fire — a game that relies on the defaults (or on their restoration after a
        // Reset) then renders its whole world with the z-buffer off.
        this.renderStates[7] = 1;    // D3DRS_ZENABLE      = D3DZB_TRUE
        this.renderStates[14] = 1;   // D3DRS_ZWRITEENABLE = TRUE
        this.renderStates[23] = 4;   // D3DRS_ZFUNC        = D3DCMP_LESSEQUAL
        // Stencil defaults (D3D9): disabled, KEEP on all outcomes, ALWAYS compare,
        // reference 0, full read/write masks, and the same front/back state until
        // TWOSIDEDSTENCILMODE is explicitly enabled.
        this.renderStates[53] = 1;   // D3DRS_STENCILFAIL   = KEEP
        this.renderStates[54] = 1;   // D3DRS_STENCILZFAIL  = KEEP
        this.renderStates[55] = 1;   // D3DRS_STENCILPASS   = KEEP
        this.renderStates[56] = 8;   // D3DRS_STENCILFUNC   = ALWAYS
        this.renderStates[58] = 0xffffffff; // D3DRS_STENCILMASK
        this.renderStates[59] = 0xffffffff; // D3DRS_STENCILWRITEMASK
        this.renderStates[186] = 1; // D3DRS_CCW_STENCILFAIL
        this.renderStates[187] = 1; // D3DRS_CCW_STENCILZFAIL
        this.renderStates[188] = 1; // D3DRS_CCW_STENCILPASS
        this.renderStates[189] = 8; // D3DRS_CCW_STENCILFUNC
        // Backface culling is ON by default in D3D9 — the same dead-`??` hole as the depth
        // states left it at 0 (= NONE), so a game that never sets it drew its interiors
        // through its walls.
        this.renderStates[22] = 3;   // D3DRS_CULLMODE     = D3DCULL_CCW
        this.renderStates[8] = 3;    // D3DRS_FILLMODE     = D3DFILL_SOLID
        this.renderStates[9] = 2;    // D3DRS_SHADEMODE    = D3DSHADE_GOURAUD
        this.renderStates[25] = 8;   // D3DRS_ALPHAFUNC    = D3DCMP_ALWAYS
        // Fog. FOGSTART/FOGEND/FOGDENSITY are floats bit-cast into the DWORD, and the FFP
        // reads them raw — an unseeded FOGEND of 0.0f makes linear fog divide by (0 - start)
        // and saturate the whole scene to the fog colour the moment a game enables fog
        // without setting the range. FOGCOLOR / the two mode states default to 0 = NONE.
        this.renderStates[37] = 0x3F800000; // D3DRS_FOGEND     = 1.0f
        this.renderStates[38] = 0x3F800000; // D3DRS_FOGDENSITY = 1.0f
    }

    // Render state management
    setRenderState(state: number, value: number): boolean {
        if (state < 0 || state >= this.renderStates.length) return false;
        if (this.renderStates[state] === value) return false;
        this.renderStates[state] = value;
        this.dirtyFlags.renderStates = true;
        this.pipelineKeyDirty = true;
        this.metrics.stateUpdates++;
        return true;
    }

    getRenderState(state: number): number {
        return this.renderStates[state] ?? 0;
    }

    // Transform management
    setTransform(type: number, matrix: Float32Array): boolean {
        let target: Float32Array;
        let base = 0;
        if (type === D3DTS_WORLD) {
            target = this.worldMatrix;
        } else if (type > D3DTS_WORLD && type < D3DTS_WORLD + FFP_WORLD_MATRIX_COUNT) {
            target = this.worldMatrices.subarray((type - D3DTS_WORLD) * 16, (type - D3DTS_WORLD + 1) * 16);
        } else if (type === D3DTS_VIEW) {
            target = this.viewMatrix;
        } else if (type === D3DTS_PROJECTION) {
            target = this.projMatrix;
        } else if (type >= D3DTS_TEXTURE0 && type < D3DTS_TEXTURE0 + FFP_TEXTURE_TRANSFORM_COUNT) {
            target = this.texMatrices;
            base = (type - D3DTS_TEXTURE0) * 16;
        } else {
            return false;
        }
        for (let i = 0; i < 16; i++) {
            if (target[base + i] !== matrix[i]) break;
            if (i === 15) return false;
        }
        for (let i = 0; i < 16; i++) target[base + i] = matrix[i]!;
        if (type === D3DTS_WORLD) this.worldMatrices.set(this.worldMatrix, 0);
        this.dirtyFlags.transforms = true;
        this.metrics.transformUpdates++;
        return true;
    }

    /** D3DTS_* MultiplyTransform: post-multiply the current matrix and publish it through the
     * same dirty/pipeline path as SetTransform. Keeping this in the tracker makes state-block
     * replay and all FFP consumers observe one canonical matrix. */
    multiplyTransform(type: number, matrix: Float32Array): boolean {
        let current: Float32Array | null = null;
        if (type === D3DTS_WORLD) current = this.worldMatrix;
        else if (type > D3DTS_WORLD && type < D3DTS_WORLD + FFP_WORLD_MATRIX_COUNT) {
            current = this.worldMatrices.subarray((type - D3DTS_WORLD) * 16, (type - D3DTS_WORLD + 1) * 16);
        }
        else if (type === D3DTS_VIEW) current = this.viewMatrix;
        else if (type === D3DTS_PROJECTION) current = this.projMatrix;
        else if (type >= D3DTS_TEXTURE0 && type < D3DTS_TEXTURE0 + FFP_TEXTURE_TRANSFORM_COUNT) {
            current = this.getTextureMatrix(type);
        }
        if (!current || matrix.length < 16) return false;
        return this.setTransform(type, multiplyMatrices(current, matrix));
    }

    getWorldMatrix(): Float32Array { return this.worldMatrix; }
    getWorldMatrixPalette(index: number): Float32Array | null {
        if (index < 0 || index >= FFP_WORLD_MATRIX_COUNT) return null;
        if (index === 0) return this.worldMatrix;
        return this.worldMatrices.subarray(index * 16, (index + 1) * 16);
    }
    getWorldMatrices(): Float32Array {
        this.worldMatrices.set(this.worldMatrix, 0);
        return this.worldMatrices;
    }
    getViewMatrix(): Float32Array { return this.viewMatrix; }
    getProjectionMatrix(): Float32Array { return this.projMatrix; }
    /** All 8 texture matrices, flat (stage N at N*16). The FFP uniform copies the whole run. */
    getTextureMatrices(): Float32Array { return this.texMatrices; }
    /** One texture matrix as a 16-float view, or null for a non-D3DTS_TEXTURE* state. */
    getTextureMatrix(type: number): Float32Array | null {
        if (type < D3DTS_TEXTURE0 || type >= D3DTS_TEXTURE0 + FFP_TEXTURE_TRANSFORM_COUNT) return null;
        const base = (type - D3DTS_TEXTURE0) * 16;
        return this.texMatrices.subarray(base, base + 16);
    }

    getMVP(): Float32Array {
        return multiplyMatrices(
            multiplyMatrices(this.worldMatrix, this.viewMatrix),
            this.projMatrix
        );
    }

    /** world × view — eye/view-space transform used by FFP lighting for pos + normal. */
    getWorldView(): Float32Array {
        return multiplyMatrices(this.worldMatrix, this.viewMatrix);
    }

    // FVF management
    setFVF(fvf: number): boolean {
        if (this.fvf === fvf) return false;
        this.fvf = fvf;
        this.dirtyFlags.fvf = true;
        this.pipelineKeyDirty = true;
        return true;
    }

    getFVF(): number { return this.fvf; }

    /**
     * Slot 0 of the binding table, or null when nothing is bound there. A VIEW, not a copy:
     * SetStreamSource writes the table and the table alone, so slot 0 cannot drift from the
     * slots the multi-stream paths read. The object is reused — treat it as valid only for
     * the duration of the call that asked for it.
     */
    getStreamSource(): StreamSource | null {
        return this.streams.bufferIndex[0]! >= 0 ? this.stream0View : null;
    }

    /** SetStreamSource/SetIndices changed a binding — the table itself is the state. */
    markStreamsDirty(): void {
        this.dirtyFlags.streams = true;
    }

    // Index source management
    setIndexSource(index: number | null): boolean {
        if (this.indexSource === index) return false;
        this.indexSource = index;
        this.dirtyFlags.streams = true;
        return true;
    }

    getIndexSource(): number | null { return this.indexSource; }

    // Texture stage management
    setTexture(stage: number, textureIndex: number | null): boolean {
        const slot = d3d9TextureStageSlot(stage);
        if (slot < 0) return false;
        if (this.textureStages[slot] === textureIndex) return false;
        this.textureStages[slot] = textureIndex;
        this.dirtyFlags.textures = true;
        this.metrics.textureChanges++;
        return true;
    }

    getTexture(stage: number): number | null {
        const slot = d3d9TextureStageSlot(stage);
        return slot >= 0 ? (this.textureStages[slot] ?? null) : null;
    }

    // Pipeline key computation
    computePipelineKey(): number {
        if (!this.pipelineKeyDirty && this.pipelineKey !== null) {
            return this.pipelineKey;
        }

        const cullMode = this.renderStates[D3DRS_CULLMODE];
        const lighting = this.renderStates[D3DRS_LIGHTING];
        // Defaults live in seedRenderStateDefaults, not here: renderStates is an Int32Array,
        // so `?? 1` at a read site is dead code (0 is not nullish) and only looks like a default.
        const zEnable = this.renderStates[D3DRS_ZENABLE];
        const zWrite = this.renderStates[D3DRS_ZWRITEENABLE];
        
        const lightingBit = lighting !== 0 ? 1 : 0;
        const zEnableBit = zEnable !== 0 ? 1 : 0;
        const zWriteBit = zWrite !== 0 ? 1 : 0;
        const fvfBits = this.fvf & 0xffff;

        // Key structure:
        // bits 0-15: FVF
        // bits 16-23: CullMode
        // bit 24: Lighting
        // bit 25: ZEnable
        // bit 26: ZWrite
        this.pipelineKey = (
            fvfBits | 
            ((cullMode & 0xff) << 16) | 
            (lightingBit << 24) | 
            (zEnableBit << 25) | 
            (zWriteBit << 26)
        ) >>> 0;
        
        this.pipelineKeyDirty = false;
        return this.pipelineKey;
    }

    // Dirty flag management
    isDirty(flag: keyof DirtyFlags): boolean {
        return this.dirtyFlags[flag];
    }

    clearDirty(flag: keyof DirtyFlags): void {
        this.dirtyFlags[flag] = false;
    }

    clearAllDirty(): void {
        this.dirtyFlags.renderStates = false;
        this.dirtyFlags.transforms = false;
        this.dirtyFlags.fvf = false;
        this.dirtyFlags.streams = false;
        this.dirtyFlags.textures = false;
    }

    // Reset state to defaults
    reset(): void {
        this.renderStates.fill(0);
        this.seedRenderStateDefaults();
        this.worldMatrix = identityMatrix();
        this.worldMatrices.fill(0);
        for (let i = 0; i < FFP_WORLD_MATRIX_COUNT; i++) this.worldMatrices.set(this.worldMatrix, i * 16);
        this.viewMatrix = identityMatrix();
        this.projMatrix = identityMatrix();
        this.resetTexMatrices();
        this.fvf = 0;
        this.indexSource = null;
        this.textureStages.fill(null);
        this.pipelineKey = null;
        this.pipelineKeyDirty = true;
        this.clearAllDirty();
        this.resetMetrics();
    }

    // Performance metrics
    resetMetrics(): void {
        this.metrics.pipelineChanges = 0;
        this.metrics.bindGroupChanges = 0;
        this.metrics.stateUpdates = 0;
        this.metrics.textureChanges = 0;
        this.metrics.transformUpdates = 0;
    }

    getMetrics(): typeof this.metrics {
        return { ...this.metrics };
    }
}

// Matrix utilities
function identityMatrix(): Float32Array {
    return new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    ]);
}

function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            out[row * 4 + col] =
                a[row * 4 + 0] * b[0 * 4 + col] +
                a[row * 4 + 1] * b[1 * 4 + col] +
                a[row * 4 + 2] * b[2 * 4 + col] +
                a[row * 4 + 3] * b[3 * 4 + col];
        }
    }
    return out;
}
