/**
 * D3D9StateTracker - Manages render state, transforms, and stream bindings
 *
 * Separated from D3D9Device to follow single-responsibility principle
 * and enable cleaner state management.
 */

const D3DRS_LIGHTING = 137;
const D3DRS_CULLMODE = 22;
const D3DRS_ZENABLE = 7;
const D3DRS_ZWRITEENABLE = 14;
const D3DCULL_NONE = 1;

const D3DTS_WORLD = 0x100;
const D3DTS_VIEW = 2;
const D3DTS_PROJECTION = 3;

export interface StreamSource {
    index: number;
    offset: number;
    stride: number;
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
    private viewMatrix: Float32Array;
    private projMatrix: Float32Array;

    // FVF and stream bindings
    private fvf: number = 0;
    private streamSource: StreamSource | null = null;
    private indexSource: number | null = null;

    // Texture stages
    private textureStages: (number | null)[] = new Array(8).fill(null);

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

    constructor() {
        this.worldMatrix = identityMatrix();
        this.viewMatrix = identityMatrix();
        this.projMatrix = identityMatrix();
        this.seedRenderStateDefaults();
    }

    /**
     * Seed the non-zero D3D9 default render states the blend/lighting pipelines depend on.
     * The render-state array is zero-filled, but several defaults are non-zero (notably
     * COLORWRITEENABLE = all channels, and the FFP material-colour sources). None of the
     * seeded states are part of the FFP pipeline key (cull/z/lighting), so the key is
     * unaffected; the lighting *enable* default is intentionally left at 0 (games set it
     * explicitly — same choice as the D3D8 adapter) to avoid darkening titles that draw
     * pre-coloured FFP geometry without ever touching lighting state.
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
        this.renderStates[134] = 1;  // D3DRS_COLORVERTEX        = TRUE
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
        if (type === D3DTS_WORLD) {
            target = this.worldMatrix;
        } else if (type === D3DTS_VIEW) {
            target = this.viewMatrix;
        } else if (type === D3DTS_PROJECTION) {
            target = this.projMatrix;
        } else {
            return false;
        }
        for (let i = 0; i < 16; i++) {
            if (target[i] !== matrix[i]) break;
            if (i === 15) return false;
        }
        for (let i = 0; i < 16; i++) target[i] = matrix[i]!;
        this.dirtyFlags.transforms = true;
        this.metrics.transformUpdates++;
        return true;
    }

    getWorldMatrix(): Float32Array { return this.worldMatrix; }
    getViewMatrix(): Float32Array { return this.viewMatrix; }
    getProjectionMatrix(): Float32Array { return this.projMatrix; }

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

    // Stream source management
    setStreamSource(index: number, offset: number, stride: number): boolean {
        const cur = this.streamSource;
        if (cur && cur.index === index && cur.offset === offset && cur.stride === stride) return false;
        this.streamSource = { index, offset, stride };
        this.dirtyFlags.streams = true;
        return true;
    }

    getStreamSource(): StreamSource | null { return this.streamSource; }

    clearStreamSource(): boolean {
        if (this.streamSource === null) return false;
        this.streamSource = null;
        this.dirtyFlags.streams = true;
        return true;
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
        if (stage < 0 || stage >= this.textureStages.length) return false;
        if (this.textureStages[stage] === textureIndex) return false;
        this.textureStages[stage] = textureIndex;
        this.dirtyFlags.textures = true;
        this.metrics.textureChanges++;
        return true;
    }

    getTexture(stage: number): number | null {
        return this.textureStages[stage] ?? null;
    }

    // Pipeline key computation
    computePipelineKey(): number {
        if (!this.pipelineKeyDirty && this.pipelineKey !== null) {
            return this.pipelineKey;
        }

        const cullMode = this.renderStates[D3DRS_CULLMODE] ?? D3DCULL_NONE;
        const lighting = this.renderStates[D3DRS_LIGHTING] ?? 0;
        const zEnable = this.renderStates[D3DRS_ZENABLE] ?? 1; // Default to true in D3D
        const zWrite = this.renderStates[D3DRS_ZWRITEENABLE] ?? 1; // Default to true in D3D
        
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
        this.viewMatrix = identityMatrix();
        this.projMatrix = identityMatrix();
        this.fvf = 0;
        this.streamSource = null;
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
