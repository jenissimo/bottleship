/**
 * Ring buffer management for DirectDraw WebGPU backend.
 * Handles vertex, index, and uniform ring buffers with triple-buffering
 * to prevent GPU/CPU race conditions.
 */

import { Logger, LogCategory } from "../../../core/logger";
import {
    RingBufferConfig,
    UniformBufferConfig,
    StorageBufferConfig,
    DEFAULT_RING_BUFFER_CONFIG,
    DEFAULT_UNIFORM_BUFFER_CONFIG,
    DEFAULT_STORAGE_BUFFER_CONFIG,
    AllocationResult,
    DrawUniformsAllocation,
    RGBA,
} from "./types";
import { FFPLightingState } from "../../../modules/ddraw/d3d/ffp-lighting";
import { packFfpLightSet, FFP_LIGHTSET_FLOATS, FFP_LIGHTSET_BYTES, FfpLightInput } from "../d3d9/ffp-lighting";
import { FfpStagesState, MAX_FFP_TEX_MATRICES } from "./ffp-stages";
import { writeMvpWithPixelCenter } from "../pixel-center";
import { GeometryUploadWindow } from "./geometry-upload-window";

/**
 * Manages GPU ring buffers for vertex, index, and uniform data.
 * Uses triple-buffering to avoid race conditions between CPU writes and GPU reads.
 */
export class RingBufferManager {
    private device: GPUDevice;
    private queue: GPUQueue;

    // Ring buffer configuration
    private readonly ringBufferSize: number;
    private readonly ringBufferCount: number;
    private readonly uniformBufferSize: number;
    private readonly storageBufferSize: number;
    private readonly storageSlotSize: number;

    // Ring buffers
    private vertexRingBuffers: GPUBuffer[] = [];
    private indexRingBuffers: GPUBuffer[] = [];
    private uniformRingBuffers: GPUBuffer[] = [];

    // Storage buffers for per-draw uniforms (MegaBatch architecture)
    private storageRingBuffers: GPUBuffer[] = [];
    private storageRingOffsets: number[] = [];
    private storageStagingBuffers: Uint8Array[] = [];
    private storageDirtyOffsets: number[] = [];

    // Current offsets within each buffer
    private vertexRingOffsets: number[] = [];
    private indexRingOffsets: number[] = [];
    private uniformRingOffsets: number[] = [];

    // CPU-side staging buffers for uniforms (to avoid per-draw writeBuffer)
    private uniformStagingBuffers: Uint8Array[] = [];
    private uniformDirtyOffsets: number[] = [];

    // Geometry is accumulated between submits so thousands of small D3D draws become one
    // queue.writeBuffer range per ring.
    private vertexUploadWindows: GeometryUploadWindow[] = [];
    private indexUploadWindows: GeometryUploadWindow[] = [];

    // Per-draw FFP light-set ring (binding 5, dynamic offset). Mirrors the uniform ring so each
    // draw can carry its own active light set (Gamebryo re-picks lights per object) without a
    // per-draw writeBuffer. Slot size = FFP_LIGHTSET_BYTES aligned to lightsAlignment.
    private lightsRingBuffers: GPUBuffer[] = [];
    private lightsRingOffsets: number[] = [];
    private lightsStagingBuffers: Uint8Array[] = [];
    private lightsDirtyOffsets: number[] = [];
    private lightsAlignment = 1024;
    private lightsScratch = new Float32Array(FFP_LIGHTSET_FLOATS);
    private drawUniformsBytes!: Uint8Array;
    private uniformDataBytes!: Uint8Array;
    private lightsScratchBytes!: Uint8Array;
    private lightsAdapted: FfpLightInput[] = [];

    // Current frame index for ring buffer rotation
    private currentFrameIndex = 0;
    private geometryStagingEnabled = true;

    // Throttle >80% warnings: only log once per 10% usage bucket per frame
    private lastVertexWarnBucket = 0;
    private lastIndexWarnBucket = 0;
    /** Cumulative count of allocateLightSlot overflows (silent last-slot reuse). */
    public lightsOverflowCount = 0;
    private lightsOverflowWarnedThisFrame = false;

    // Device-specific uniform buffer alignment requirement
    private uniformAlignment: number;

    // Uniform data scratch buffer (reused to avoid allocations)
    private uniformData: Float32Array;
    private uniformDataU32: Uint32Array;
    private uniformDataView: DataView;

    // Identity matrix (reused to avoid allocation per draw)
    private readonly IDENTITY_MAT4 = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    ]);

    // Uniform caching to reuse offsets for identical data
    private lastUniformData: Float32Array;
    private lastUniformOffset: number = -1;
    private lastUniformFrame: number = -1;

    // Draw uniforms scratch buffer (reused to avoid allocations)
    private drawUniformsData: Float32Array;
    private drawUniformsBits: Uint32Array;
    private drawUniformsView: DataView;
    private lastDrawUniformsBits: Uint32Array;
    private lastDrawUniformIndex: number = -1;
    private lastDrawUniformFrame: number = -1;

    constructor(
        device: GPUDevice,
        queue: GPUQueue,
        ringConfig: RingBufferConfig = DEFAULT_RING_BUFFER_CONFIG,
        uniformConfig: UniformBufferConfig = DEFAULT_UNIFORM_BUFFER_CONFIG,
        storageConfig: StorageBufferConfig = DEFAULT_STORAGE_BUFFER_CONFIG
    ) {
        this.device = device;
        this.queue = queue;
        this.ringBufferSize = ringConfig.bufferSize;
        this.ringBufferCount = ringConfig.bufferCount;
        this.uniformBufferSize = uniformConfig.bufferSize;
        this.storageBufferSize = storageConfig.bufferSize;
        this.storageSlotSize = storageConfig.slotSize;

        // Get device-specific uniform buffer alignment requirement
        // WebGPU spec requires minimum 256 bytes, but some implementations may require more.
        // Slot stride = slotSize rounded up to the device alignment (dynamic offsets must be
        // multiples of minUniformBufferOffsetAlignment, and slotSize=768 is not a power of two).
        const deviceAlignment = device.limits.minUniformBufferOffsetAlignment || 256;
        this.uniformAlignment = Math.ceil(uniformConfig.slotSize / deviceAlignment) * deviceAlignment;
        // Light-set slot stride: FFP_LIGHTSET_BYTES (912) rounded up to the device alignment.
        this.lightsAlignment = Math.ceil(FFP_LIGHTSET_BYTES / deviceAlignment) * deviceAlignment;

        // Initialize uniform data scratch buffer
        this.uniformData = new Float32Array(uniformConfig.slotSize / 4);
        this.uniformDataU32 = new Uint32Array(
            this.uniformData.buffer,
            this.uniformData.byteOffset,
            uniformConfig.slotSize / 4
        );
        this.lastUniformData = new Float32Array(uniformConfig.slotSize / 4);
        this.uniformDataView = new DataView(
            this.uniformData.buffer,
            this.uniformData.byteOffset,
            uniformConfig.slotSize
        );

        // Initialize draw uniforms scratch buffer for storage buffer writes
        this.drawUniformsData = new Float32Array(storageConfig.slotSize / 4);
        this.drawUniformsBits = new Uint32Array(
            this.drawUniformsData.buffer,
            this.drawUniformsData.byteOffset,
            storageConfig.slotSize / 4
        );
        this.lastDrawUniformsBits = new Uint32Array(storageConfig.slotSize / 4);
        this.drawUniformsView = new DataView(
            this.drawUniformsData.buffer,
            this.drawUniformsData.byteOffset,
            storageConfig.slotSize
        );
        // Byte views over the scratch buffers, used only as the SOURCE of the staging copy.
        // The scratch Float32Arrays are allocated once here, so these never need rebuilding —
        // constructing them per draw/per slot was an allocation on the hot path.
        this.drawUniformsBytes = new Uint8Array(this.drawUniformsData.buffer, 0, storageConfig.slotSize);
        this.uniformDataBytes = new Uint8Array(this.uniformData.buffer, 0, this.uniformData.byteLength);
        this.lightsScratchBytes = new Uint8Array(this.lightsScratch.buffer, 0, FFP_LIGHTSET_BYTES);

        this.initializeBuffers();
    }

    private initializeBuffers(): void {
        for (let i = 0; i < this.ringBufferCount; i++) {
            // Vertex ring buffer
            this.vertexRingBuffers.push(
                this.device.createBuffer({
                    size: this.ringBufferSize,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                })
            );

            // Index ring buffer
            this.indexRingBuffers.push(
                this.device.createBuffer({
                    size: this.ringBufferSize,
                    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
                })
            );
            this.vertexUploadWindows.push(new GeometryUploadWindow());
            this.indexUploadWindows.push(new GeometryUploadWindow());

            // Uniform ring buffer
            this.uniformRingBuffers.push(
                this.device.createBuffer({
                    size: this.uniformBufferSize,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                })
            );
            this.uniformStagingBuffers.push(new Uint8Array(this.uniformBufferSize));
            this.uniformDirtyOffsets.push(0);

            // Per-draw FFP light-set ring buffer (binding 5, dynamic offset).
            this.lightsRingBuffers.push(
                this.device.createBuffer({
                    size: this.uniformBufferSize,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                })
            );
            this.lightsStagingBuffers.push(new Uint8Array(this.uniformBufferSize));
            this.lightsDirtyOffsets.push(0);
            this.lightsRingOffsets.push(0);

            // Storage ring buffer for per-draw uniforms (MegaBatch)
            this.storageRingBuffers.push(
                this.device.createBuffer({
                    size: this.storageBufferSize,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                })
            );
            this.storageStagingBuffers.push(new Uint8Array(this.storageBufferSize));
            this.storageDirtyOffsets.push(0);
            this.storageRingOffsets.push(0);

            this.vertexRingOffsets.push(0);
            this.indexRingOffsets.push(0);
            this.uniformRingOffsets.push(0);
        }
    }

    /**
     * Get current uniform buffer alignment requirement
     */
    getUniformAlignment(): number {
        return this.uniformAlignment;
    }

    /**
     * Get current frame index
     */
    getCurrentFrameIndex(): number {
        return this.currentFrameIndex;
    }

    /**
     * Get current uniform buffer for bind group creation
     */
    getCurrentUniformBuffer(): GPUBuffer {
        return this.uniformRingBuffers[this.currentFrameIndex];
    }

    /** Publish staged vertex/index ranges before the encoder that consumes them is submitted. */
    flushGeometry(): void {
        const fi = this.currentFrameIndex;
        this.vertexUploadWindows[fi].flush(this.queue, this.vertexRingBuffers[fi], this.vertexRingOffsets[fi]);
        this.indexUploadWindows[fi].flush(this.queue, this.indexRingBuffers[fi], this.indexRingOffsets[fi]);
    }

    setGeometryStagingEnabled(enabled: boolean): void {
        if (this.geometryStagingEnabled === enabled) return;
        const fi = this.currentFrameIndex;
        if (!enabled) {
            this.flushGeometry();
        } else {
            this.vertexUploadWindows[fi].advanceTo(this.vertexRingOffsets[fi]);
            this.indexUploadWindows[fi].advanceTo(this.indexRingOffsets[fi]);
        }
        this.geometryStagingEnabled = enabled;
    }

    /**
     * Flush CPU-side uniform data to GPU
     */
    flushUniforms(): void {
        const offset = this.uniformRingOffsets[this.currentFrameIndex];
        const dirtyOffset = this.uniformDirtyOffsets[this.currentFrameIndex];

        if (offset > dirtyOffset) {
            const buffer = this.uniformRingBuffers[this.currentFrameIndex];
            const staging = this.uniformStagingBuffers[this.currentFrameIndex];

            // Write only the newly added data
            this.queue.writeBuffer(
                buffer,
                dirtyOffset,
                staging.buffer,
                dirtyOffset,
                offset - dirtyOffset
            );

            this.uniformDirtyOffsets[this.currentFrameIndex] = offset;
        }
    }

    // ===== Per-draw FFP light-set ring (binding 5) =====

    /** Current light-set ring buffer for bind-group creation. */
    getCurrentLightsBuffer(): GPUBuffer {
        return this.lightsRingBuffers[this.currentFrameIndex];
    }

    /**
     * Allocate + pack a per-draw light set into the lights ring, returning the dynamic offset
     * to bind at binding 5. Lights are packed in VIEW space (transformed world→view by the
     * state's viewMatrix) so they match the view-space vertex position/normal the FFP lighting
     * shader computes from worldView. Falls back to world space (identity view) when no view
     * matrix is available. On overflow the last slot is reused (degrades gracefully, never OOB).
     */
    allocateLightSlot(lightingState: FFPLightingState | undefined): number {
        const offset = this.lightsRingOffsets[this.currentFrameIndex];
        if (offset + this.lightsAlignment > this.uniformBufferSize) {
            this.lightsOverflowCount++;
            if (!this.lightsOverflowWarnedThisFrame) {
                this.lightsOverflowWarnedThisFrame = true;
                Logger.warn(
                    LogCategory.SYSTEM,
                    `RingBufferManager: Lights ring overflow — reusing last slot (wrong lights for tail draws)! ` +
                        `offset=${offset}/${this.uniformBufferSize}`
                );
            }
            return Math.max(0, offset - this.lightsAlignment);
        }

        // Adapt the backend-neutral light list (D3DLight7Data → FfpLightInput) into the reused array.
        const src = lightingState?.lights ?? [];
        this.lightsAdapted.length = 0;
        for (let i = 0; i < src.length && i < 8; i++) {
            const L = src[i];
            this.lightsAdapted.push({
                type: L.type,
                diffuse: L.diffuse, specular: L.specular, ambient: L.ambient,
                position: [L.position.x, L.position.y, L.position.z],
                direction: [L.direction.x, L.direction.y, L.direction.z],
                range: L.range, falloff: L.falloff,
                att0: L.attenuation0, att1: L.attenuation1, att2: L.attenuation2,
                theta: L.theta, phi: L.phi,
            });
        }
        // Transform lights world→view so they share the shader's view-space lighting frame.
        packFfpLightSet(this.lightsScratch, this.lightsAdapted, lightingState?.viewMatrix ?? undefined);

        const staging = this.lightsStagingBuffers[this.currentFrameIndex];
        staging.set(this.lightsScratchBytes, offset);
        this.lightsRingOffsets[this.currentFrameIndex] = offset + this.lightsAlignment;
        return offset;
    }

    /** Flush newly written light-set data to the GPU (mirror of flushUniforms). */
    flushLights(): void {
        const offset = this.lightsRingOffsets[this.currentFrameIndex];
        const dirtyOffset = this.lightsDirtyOffsets[this.currentFrameIndex];
        if (offset > dirtyOffset) {
            this.queue.writeBuffer(
                this.lightsRingBuffers[this.currentFrameIndex],
                dirtyOffset,
                this.lightsStagingBuffers[this.currentFrameIndex].buffer,
                dirtyOffset,
                offset - dirtyOffset
            );
            this.lightsDirtyOffsets[this.currentFrameIndex] = offset;
        }
    }

    // ===== Storage Buffer Management (MegaBatch Architecture) =====

    /**
     * Get current storage buffer for bind group creation
     */
    getCurrentStorageBuffer(): GPUBuffer {
        return this.storageRingBuffers[this.currentFrameIndex];
    }

    /**
     * Get current storage buffer offset (in draw indices, not bytes)
     */
    getCurrentStorageIndex(): number {
        return this.storageRingOffsets[this.currentFrameIndex] / this.storageSlotSize;
    }

    /**
     * Flush CPU-side storage buffer data to GPU
     */
    flushStorageBuffer(): void {
        const offset = this.storageRingOffsets[this.currentFrameIndex];
        const dirtyOffset = this.storageDirtyOffsets[this.currentFrameIndex];

        if (offset > dirtyOffset) {
            const buffer = this.storageRingBuffers[this.currentFrameIndex];
            const staging = this.storageStagingBuffers[this.currentFrameIndex];

            // Write only the newly added data
            this.queue.writeBuffer(
                buffer,
                dirtyOffset,
                staging.buffer,
                dirtyOffset,
                offset - dirtyOffset
            );

            this.storageDirtyOffsets[this.currentFrameIndex] = offset;
        }
    }

    /**
     * Allocate a draw uniform slot in the storage buffer.
     * Returns the index into the draws array (for use with instance_index in shader).
     *
     * Storage slot layout (512 bytes per draw — must mirror the MegaBatch DrawUniforms
     * struct in shader-generator.ts):
     *    0..64   mvp: mat4x4<f32>
     *   64..80   textureFactor: vec4f
     *   80..96   colorKey: vec4f
     *   96..112  ambientColor: vec4f
     *  112..128  fogColor: vec4f
     *  128..144  fogParams: vec4f (start, end, density, mode)
     *  144..160  viewport: vec4f (width, height, minZ, maxZ)
     *  160..176  misc: vec4u (alphaRef255, isRHW, lightingEnabled, colorKeyEnabled)
     *  176..192  misc2: vec4u (premultiplyOutput, alphaTestEnabled, alphaFunc, specularEnable)
     *  192..320  stages: array<vec4u, MAX_FFP_STAGES> (packed cascade, see ffp-stages.ts)
     *  320..384  world: mat4x4<f32>
     *  384..448  matDiffuse/matAmbient/matSpecular/matEmissive: vec4f×4
     *  448..464  matParams: vec4f (x = power)
     *  464..480  matSrcs: vec4u (diffuseSrc, ambientSrc, specularSrc, emissiveSrc)
     *  480..496  lightColor: vec4f
     *  496..512  lightDir: vec4f (xyz = dir, w = hasDirLight)
     */
    allocateDrawUniforms(
        viewportWidth: number,
        viewportHeight: number,
        minZ: number,
        maxZ: number,
        alphaRef: number,
        isRHW: number,
        lightingEnabled: number,
        ambientR: number,
        ambientG: number,
        ambientB: number,
        ambientA: number,
        colorKeyEnabled: number,
        colorKeyR: number,
        colorKeyG: number,
        colorKeyB: number,
        colorKeyA: number,
        mvpMatrix: Float32Array | undefined,
        fogMode: number,
        fogStart: number,
        fogEnd: number,
        fogDensity: number,
        fogColorR: number,
        fogColorG: number,
        fogColorB: number,
        fogColorA: number,
        textureFactorR: number,
        textureFactorG: number,
        textureFactorB: number,
        textureFactorA: number,
        /** Resolved + packed FFP stage cascade (stages.pack() must have run). */
        stages: FfpStagesState,
        specularEnable: number,
        premultiplyOutput: number,
        alphaTestEnabled: number,
        alphaFunc: number,
        // Lighting data (Material + World Matrix)
        worldMatrix: Float32Array | null,
        matDiffuse: RGBA,
        matAmbient: RGBA,
        matSpecular: RGBA,
        matEmissive: RGBA,
        matPower: number,
        matDiffuseSrc: number,
        matAmbientSrc: number,
        matSpecularSrc: number,
        matEmissiveSrc: number,
        lightingState: FFPLightingState | undefined
    ): DrawUniformsAllocation {
        const buffer = this.storageRingBuffers[this.currentFrameIndex];
        const offset = this.storageRingOffsets[this.currentFrameIndex];
        const index = offset / this.storageSlotSize;

        if (offset + this.storageSlotSize > this.storageBufferSize) {
            Logger.error(
                LogCategory.SYSTEM,
                `RingBufferManager: Storage buffer overflow! ` +
                    `offset=${offset} required=${this.storageSlotSize} size=${this.storageBufferSize}`
            );
            return { buffer, index: 0 };
        }

        const data = this.drawUniformsData;
        const bits = this.drawUniformsBits;
        const view = this.drawUniformsView;

        // Clear the buffer
        data.fill(0);

        // mvp @0 (floats 0..15), carrying the pixel-centre shift for this viewport
        // (webgpu/pixel-center.ts owns the convention and the equivalence with the
        // pre-transformed path).
        if (mvpMatrix && mvpMatrix.length >= 16) {
            writeMvpWithPixelCenter(data, 0, mvpMatrix, viewportWidth, viewportHeight);
        } else {
            // Identity matrix
            data[0] = 1; data[5] = 1; data[10] = 1; data[15] = 1;
        }

        // textureFactor @64
        data[16] = textureFactorR;
        data[17] = textureFactorG;
        data[18] = textureFactorB;
        data[19] = textureFactorA;

        // colorKey @80
        data[20] = colorKeyR;
        data[21] = colorKeyG;
        data[22] = colorKeyB;
        data[23] = colorKeyA;

        // ambientColor @96
        data[24] = ambientR;
        data[25] = ambientG;
        data[26] = ambientB;
        data[27] = ambientA;

        // fogColor @112
        data[28] = fogColorR;
        data[29] = fogColorG;
        data[30] = fogColorB;
        data[31] = fogColorA;

        // fogParams @128
        data[32] = fogStart;
        data[33] = fogEnd;
        data[34] = fogDensity;
        data[35] = fogMode;

        // viewport @144
        data[36] = viewportWidth;
        data[37] = viewportHeight;
        data[38] = minZ;
        data[39] = maxZ;

        // misc @160
        const alphaRef255 = Math.max(0, Math.min(255, Math.round(alphaRef) & 0xff));
        view.setUint32(160, alphaRef255 >>> 0, true);
        view.setUint32(164, isRHW >>> 0, true);
        view.setUint32(168, lightingEnabled >>> 0, true);
        view.setUint32(172, colorKeyEnabled >>> 0, true);

        // misc2 @176
        view.setUint32(176, premultiplyOutput >>> 0, true);
        view.setUint32(180, alphaTestEnabled >>> 0, true);
        view.setUint32(184, alphaFunc >>> 0, true);
        view.setUint32(188, specularEnable >>> 0, true);

        // stages @192 (u32 words 48..79)
        bits.set(stages.packed, 48);

        // world @320 (floats 80..95)
        const worldOffset = 80;
        if (worldMatrix && worldMatrix.length >= 16) {
            for (let i = 0; i < 16; i++) {
                data[worldOffset + i] = worldMatrix[i];
            }
        } else {
            // Identity matrix
            data[worldOffset + 0] = 1; data[worldOffset + 5] = 1; data[worldOffset + 10] = 1; data[worldOffset + 15] = 1;
        }

        // Material @384 (floats 96..111)
        data[96] = matDiffuse.r;
        data[97] = matDiffuse.g;
        data[98] = matDiffuse.b;
        data[99] = matDiffuse.a;

        data[100] = matAmbient.r;
        data[101] = matAmbient.g;
        data[102] = matAmbient.b;
        data[103] = matAmbient.a;

        data[104] = matSpecular.r;
        data[105] = matSpecular.g;
        data[106] = matSpecular.b;
        data[107] = matSpecular.a;

        data[108] = matEmissive.r;
        data[109] = matEmissive.g;
        data[110] = matEmissive.b;
        data[111] = matEmissive.a;

        // matParams @448 (x = power)
        data[112] = matPower;

        // matSrcs @464
        view.setUint32(464, matDiffuseSrc >>> 0, true);
        view.setUint32(468, matAmbientSrc >>> 0, true);
        view.setUint32(472, matSpecularSrc >>> 0, true);
        view.setUint32(476, matEmissiveSrc >>> 0, true);

        // Find first enabled directional light
        let dirLightColor = { r: 0, g: 0, b: 0, a: 0 };
        let dirLightDir = { x: 0, y: 0, z: 1 };
        let hasDirLight = 0;

        if (lightingState && lightingState.lights) {
            for (const light of lightingState.lights) {
                if (light.type === 3) { // D3DLIGHT_DIRECTIONAL
                    dirLightColor = light.diffuse;
                    dirLightDir = light.direction;
                    hasDirLight = 1;
                    break;
                }
            }
        }

        // lightColor @480, lightDir @496 (w = hasDirLight)
        data[120] = dirLightColor.r;
        data[121] = dirLightColor.g;
        data[122] = dirLightColor.b;
        data[123] = dirLightColor.a;

        data[124] = dirLightDir.x;
        data[125] = dirLightDir.y;
        data[126] = dirLightDir.z;
        data[127] = hasDirLight;

        if (this.lastDrawUniformIndex !== -1 && this.lastDrawUniformFrame === this.currentFrameIndex) {
            let match = true;
            for (let i = 0; i < this.drawUniformsBits.length; i++) {
                if (this.drawUniformsBits[i] !== this.lastDrawUniformsBits[i]) {
                    match = false;
                    break;
                }
            }
            if (match) {
                return { buffer, index: this.lastDrawUniformIndex };
            }
        }

        // Write to CPU staging buffer
        const staging = this.storageStagingBuffers[this.currentFrameIndex];
        staging.set(this.drawUniformsBytes, offset);

        this.lastDrawUniformsBits.set(this.drawUniformsBits);
        this.lastDrawUniformIndex = index;
        this.lastDrawUniformFrame = this.currentFrameIndex;

        this.storageRingOffsets[this.currentFrameIndex] = offset + this.storageSlotSize;

        return { buffer, index };
    }

    /**
     * Ensure space is available in all ring buffers before starting a draw.
     * This prevents race conditions where uniformOffset is allocated in one buffer,
     * but vertex/index allocation triggers a buffer switch.
     *
     * @param bytesV - Required vertex buffer size
     * @param bytesI - Required index buffer size (0 if not using indices)
     * @param bytesU - Required uniform buffer size (aligned)
     * @param flushCallback - Callback to flush pending render commands
     * @param bytesS - Required storage buffer size (0 if not using MegaBatch)
     * @returns true if buffer was switched
     */
    ensureSpaceForDraw(
        bytesV: number,
        bytesI: number,
        bytesU: number,
        flushCallback: () => void,
        bytesS: number = 0
    ): boolean {
        const alignedV = (bytesV + 3) & ~3;
        const alignedI = (bytesI + 3) & ~3;
        const alignedU = bytesU;
        const alignedS = bytesS;

        const vOffset = this.vertexRingOffsets[this.currentFrameIndex];
        const iOffset = this.indexRingOffsets[this.currentFrameIndex];
        const uOffset = this.uniformRingOffsets[this.currentFrameIndex];
        const sOffset = this.storageRingOffsets[this.currentFrameIndex];

        const vOverflow = vOffset + alignedV > this.ringBufferSize;
        const iOverflow = bytesI > 0 && iOffset + alignedI > this.ringBufferSize;
        const uOverflow = uOffset + alignedU > this.uniformBufferSize;
        const sOverflow = bytesS > 0 && sOffset + alignedS > this.storageBufferSize;

        if (vOverflow || iOverflow || uOverflow || sOverflow) {
            Logger.warn(
                LogCategory.SYSTEM,
                `⚠️ RingBufferManager: Ring buffer overflow detected! ` +
                    `(v=${vOverflow} i=${iOverflow} u=${uOverflow} s=${sOverflow}) ` +
                    `vOffset=${vOffset}/${this.ringBufferSize} ` +
                    `iOffset=${iOffset}/${this.ringBufferSize} ` +
                    `uOffset=${uOffset}/${this.uniformBufferSize} ` +
                    `sOffset=${sOffset}/${this.storageBufferSize} ` +
                    `→ Flushing and switching buffer (this causes frame stall!)`
            );

            flushCallback();

            // Switch to next buffer in ring
            this.currentFrameIndex = (this.currentFrameIndex + 1) % this.ringBufferCount;
            this.vertexRingOffsets[this.currentFrameIndex] = 0;
            this.indexRingOffsets[this.currentFrameIndex] = 0;
            this.vertexUploadWindows[this.currentFrameIndex].reset();
            this.indexUploadWindows[this.currentFrameIndex].reset();
            this.uniformRingOffsets[this.currentFrameIndex] = 0;
            this.uniformDirtyOffsets[this.currentFrameIndex] = 0;
            this.lightsRingOffsets[this.currentFrameIndex] = 0;
            this.lightsDirtyOffsets[this.currentFrameIndex] = 0;
            this.storageRingOffsets[this.currentFrameIndex] = 0;
            this.storageDirtyOffsets[this.currentFrameIndex] = 0;
            // Same ring-index aliasing hazard as nextFrame(): kill the dedup cache.
            this.lastUniformOffset = -1;
            this.lastUniformFrame = -1;
            this.lastDrawUniformIndex = -1;
            this.lastDrawUniformFrame = -1;
            return true;
        }

        return false;
    }

    /**
     * Allocate vertex data in the current ring buffer from CPU array
     */
    allocateVertexData(data: Uint8Array): AllocationResult {
        const alignedSize = (data.byteLength + 3) & ~3;
        const buffer = this.vertexRingBuffers[this.currentFrameIndex];
        const offset = this.vertexRingOffsets[this.currentFrameIndex];

        const usagePercent = (offset / this.ringBufferSize) * 100;
        const usageBucket = Math.floor(usagePercent / 10);
        if (usagePercent > 80 && usageBucket > this.lastVertexWarnBucket) {
            this.lastVertexWarnBucket = usageBucket;
            Logger.warn(
                LogCategory.SYSTEM,
                `RingBufferManager: Vertex ring buffer ${usagePercent.toFixed(1)}% full`
            );
        }

        if (offset + alignedSize > this.ringBufferSize) {
            Logger.error(
                LogCategory.SYSTEM,
                `RingBufferManager: Vertex buffer overflow in allocateVertexData! ` +
                    `offset=${offset} required=${alignedSize} size=${this.ringBufferSize}`
            );
            return { buffer, offset: 0, overflow: true };
        }

        if (this.geometryStagingEnabled) {
            this.vertexUploadWindows[this.currentFrameIndex].stage(offset, data);
        } else {
            this.queue.writeBuffer(buffer, offset, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
            // These bytes are already on the queue. The window's cursor has to follow the
            // ring even when it is not staging, or the next flush republishes this range
            // out of a staging array that never received it — an empty one throws, and a
            // stale one overwrites the frame's real geometry.
            this.vertexUploadWindows[this.currentFrameIndex].advanceTo(offset + alignedSize);
        }
        this.vertexRingOffsets[this.currentFrameIndex] = offset + alignedSize;

        return { buffer, offset };
    }

    /**
     * Allocate vertex data in the current ring buffer from GPU buffer (via copyBufferToBuffer)
     * This is more efficient than readback + writeBuffer for GPU-converted vertices.
     */
    allocateVertexDataFromGpuBuffer(
        encoder: GPUCommandEncoder,
        srcBuffer: GPUBuffer,
        srcOffset: number,
        size: number
    ): AllocationResult {
        const alignedSize = (size + 3) & ~3;
        const buffer = this.vertexRingBuffers[this.currentFrameIndex];
        const dstOffset = this.vertexRingOffsets[this.currentFrameIndex];

        const usagePercent = (dstOffset / this.ringBufferSize) * 100;
        const usageBucket = Math.floor(usagePercent / 10);
        if (usagePercent > 80 && usageBucket > this.lastVertexWarnBucket) {
            this.lastVertexWarnBucket = usageBucket;
            Logger.warn(
                LogCategory.SYSTEM,
                `RingBufferManager: Vertex ring buffer ${usagePercent.toFixed(1)}% full`
            );
        }

        if (dstOffset + alignedSize > this.ringBufferSize) {
            Logger.error(
                LogCategory.SYSTEM,
                `RingBufferManager: Vertex buffer overflow in allocateVertexDataFromGpuBuffer! ` +
                    `offset=${dstOffset} required=${alignedSize} size=${this.ringBufferSize}`
            );
            return { buffer, offset: 0, overflow: true };
        }

        // Publish any CPU-staged prefix first, then exclude the GPU-produced range from the
        // next staging upload so a later flush cannot overwrite the copy with stale bytes.
        const uploadWindow = this.vertexUploadWindows[this.currentFrameIndex];
        uploadWindow.flush(this.queue, buffer, dstOffset);
        encoder.copyBufferToBuffer(srcBuffer, srcOffset, buffer, dstOffset, size);
        this.vertexRingOffsets[this.currentFrameIndex] = dstOffset + alignedSize;
        uploadWindow.advanceTo(dstOffset + alignedSize);

        return { buffer, offset: dstOffset };
    }

    /**
     * Allocate index data in the current ring buffer
     */
    allocateIndexData(data: Uint8Array): AllocationResult {
        const alignedSize = (data.byteLength + 3) & ~3;
        const buffer = this.indexRingBuffers[this.currentFrameIndex];
        const offset = this.indexRingOffsets[this.currentFrameIndex];

        const usagePercent = (offset / this.ringBufferSize) * 100;
        const usageBucket = Math.floor(usagePercent / 10);
        if (usagePercent > 80 && usageBucket > this.lastIndexWarnBucket) {
            this.lastIndexWarnBucket = usageBucket;
            Logger.warn(
                LogCategory.SYSTEM,
                `RingBufferManager: Index ring buffer ${usagePercent.toFixed(1)}% full`
            );
        }

        if (offset + alignedSize > this.ringBufferSize) {
            Logger.error(
                LogCategory.SYSTEM,
                `RingBufferManager: Index buffer overflow in allocateIndexData! ` +
                    `offset=${offset} required=${alignedSize} size=${this.ringBufferSize}`
            );
            return { buffer, offset: 0, overflow: true };
        }

        if (this.geometryStagingEnabled) {
            this.indexUploadWindows[this.currentFrameIndex].stage(offset, data);
        } else {
            this.queue.writeBuffer(buffer, offset, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
            // These bytes are already on the queue. The window's cursor has to follow the
            // ring even when it is not staging, or the next flush republishes this range
            // out of a staging array that never received it — an empty one throws, and a
            // stale one overwrites the frame's real geometry.
            this.indexUploadWindows[this.currentFrameIndex].advanceTo(offset + alignedSize);
        }
        this.indexRingOffsets[this.currentFrameIndex] = offset + alignedSize;

        return { buffer, offset };
    }

    /**
     * Allocate uniform slot and write data.
     * Fog: fogMode 0=none, 0.5=vertex fog, 1=exp, 2=exp2, 3=linear.
     *
     * Slot layout (768-byte slot, 736 used — must mirror the legacy Uniforms struct in
     * shader-generator.ts):
     *    0..16   viewport vec2f + minZ + maxZ
     *   16..32   alphaRef255, isRHW, lightingEnabled, colorKeyEnabled (u32)
     *   32..48   specularEnable, premultiplyOutput, hasNormal, localViewer (u32)
     *   48..96   colorKey / ambientColor / textureFactor (vec4f×3)
     *   96..160  mvp
     *  160..192  fogColor / fogParams
     *  192..320  stages: array<vec4u, MAX_FFP_STAGES> (packed cascade, see ffp-stages.ts)
     *  320..384  world
     *  384..448  matDiffuse/matAmbient/matSpecular/matEmissive
     *  448..480  matPower + material source selectors
     *  480..672  texMat0/1/2 (MAX_FFP_TEX_MATRICES)
     *  672..736  worldView (camera-space texgen)
     *  736..740  clipPlaneEnable (u32, D3DRS_CLIPPLANEENABLE bitmask) — first spare word
     */
    allocateUniformSlot(
        viewportWidth: number,
        viewportHeight: number,
        minZ: number,
        maxZ: number,
        alphaRef: number,
        isRHW: number,
        lightingEnabled: number,
        ambientR: number,
        ambientG: number,
        ambientB: number,
        ambientA: number,
        colorKeyEnabled: number,
        colorKeyR: number,
        colorKeyG: number,
        colorKeyB: number,
        colorKeyA: number,
        mvpMatrix: Float32Array | undefined,
        fogMode: number,
        fogStart: number,
        fogEnd: number,
        fogDensity: number,
        fogColorR: number,
        fogColorG: number,
        fogColorB: number,
        fogColorA: number,
        textureFactorR: number,
        textureFactorG: number,
        textureFactorB: number,
        textureFactorA: number,
        /** Resolved + packed FFP stage cascade (stages.pack() must have run). */
        stages: FfpStagesState,
        specularEnable: number,
        premultiplyOutput: number,
        // FFP lighting flags: hasNormal (FVF D3DFVF_NORMAL present) gates directional shading in
        // the shader; localViewer (D3DRS_LOCALVIEWER) selects the specular half-vector model.
        hasNormal: number,
        localViewer: number,
        // Per-stage texture matrices (D3DTS_TEXTUREn, gated by stages[N].w flags).
        texMatrices: readonly (Float32Array | null)[] | null,
        // World×View matrix for camera-space texgen (D3DTSS_TCI_CAMERASPACE*).
        worldViewMatrix: Float32Array | null,
        // Lighting data
        worldMatrix: Float32Array | null,
        matDiffuse: RGBA,
        matAmbient: RGBA,
        matSpecular: RGBA,
        matEmissive: RGBA,
        matPower: number,
        matDiffuseSrc: number,
        matAmbientSrc: number,
        matSpecularSrc: number,
        matEmissiveSrc: number,
        lightingState: FFPLightingState | undefined,
        // D3DRS_CLIPPLANEENABLE bitmask (bit N = user clip plane N). 0 → clipping inert.
        clipPlaneEnable: number
    ): number {
        const buffer = this.uniformRingBuffers[this.currentFrameIndex];
        const offset = this.uniformRingOffsets[this.currentFrameIndex];

        if (offset + this.uniformAlignment > this.uniformBufferSize) {
            Logger.error(
                LogCategory.SYSTEM,
                `RingBufferManager: Uniform buffer overflow in allocateUniformSlot! ` +
                    `offset=${offset} required=${this.uniformAlignment} size=${this.uniformBufferSize}`
            );
            return 0;
        }

        // Reuse a single scratch slot, but always reset it to avoid leaking fields
        // from the previous draw when optional matrices/material data are absent.
        this.uniformData.fill(0);

        // viewport @0
        this.uniformData[0] = viewportWidth;
        this.uniformData[1] = viewportHeight;
        this.uniformData[2] = minZ;
        this.uniformData[3] = maxZ;
        const alphaRef255 = Math.max(0, Math.min(255, Math.round(alphaRef) & 0xff));

        // Flag words @16 and @32
        const view = this.uniformDataView;
        view.setUint32(16, alphaRef255 >>> 0, true);
        view.setUint32(20, isRHW >>> 0, true);
        view.setUint32(24, lightingEnabled >>> 0, true);
        view.setUint32(28, colorKeyEnabled >>> 0, true);
        view.setUint32(32, specularEnable >>> 0, true);
        view.setUint32(36, premultiplyOutput >>> 0, true);
        // hasNormal @40, localViewer @44 (Uniforms struct: was _pad0/_pad1). FFP lighting flags.
        view.setUint32(40, hasNormal >>> 0, true);
        view.setUint32(44, localViewer >>> 0, true);

        // colorKey @48 (floats 12..15)
        this.uniformData[12] = colorKeyR;
        this.uniformData[13] = colorKeyG;
        this.uniformData[14] = colorKeyB;
        this.uniformData[15] = colorKeyA;

        // ambientColor @64 (floats 16..19)
        this.uniformData[16] = ambientR;
        this.uniformData[17] = ambientG;
        this.uniformData[18] = ambientB;
        this.uniformData[19] = ambientA;

        // textureFactor @80 (floats 20..23)
        this.uniformData[20] = textureFactorR;
        this.uniformData[21] = textureFactorG;
        this.uniformData[22] = textureFactorB;
        this.uniformData[23] = textureFactorA;

        // mvp @96 (floats 24..39), carrying the pixel-centre shift for this viewport
        // (webgpu/pixel-center.ts owns the convention and the equivalence with the
        // pre-transformed path).
        const mvpOffset = 24;
        if (mvpMatrix && mvpMatrix.length >= 16) {
            writeMvpWithPixelCenter(this.uniformData, mvpOffset, mvpMatrix, viewportWidth, viewportHeight);
        } else {
            // Use identity matrix (normal for XYZRHW/pre-transformed vertices)
            // Only log warning for XYZ vertices (isRHW === 0) that actually need MVP
            if (isRHW === 0) {
                // XYZ vertices need MVP - missing matrix is a problem
                if (!mvpMatrix) {
                    Logger.warn(LogCategory.SYSTEM, "RingBufferManager: MVP matrix missing for XYZ vertices, using identity");
                } else if (mvpMatrix.length < 16) {
                    Logger.warn(LogCategory.SYSTEM, `RingBufferManager: MVP matrix has invalid length ${mvpMatrix.length}, using identity`);
                }
            }
            // For XYZRHW (isRHW !== 0), missing MVP is expected - no warning needed
            for (let i = 0; i < 16; i++) {
                this.uniformData[mvpOffset + i] = this.IDENTITY_MAT4[i];
            }
        }

        // fogColor @160 (floats 40..43), fogParams @176 (floats 44..47)
        this.uniformData[40] = fogColorR;
        this.uniformData[41] = fogColorG;
        this.uniformData[42] = fogColorB;
        this.uniformData[43] = fogColorA;
        this.uniformData[44] = fogStart;
        this.uniformData[45] = fogEnd;
        this.uniformData[46] = fogDensity;
        this.uniformData[47] = fogMode;

        // stages @192 (u32 words 48..79)
        this.uniformDataU32.set(stages.packed, 48);

        // world @320 (floats 80..95)
        const worldIdx = 80;
        if (worldMatrix && worldMatrix.length >= 16) {
            for (let i = 0; i < 16; i++) {
                this.uniformData[worldIdx + i] = worldMatrix[i];
            }
        } else {
            for (let i = 0; i < 16; i++) {
                this.uniformData[worldIdx + i] = this.IDENTITY_MAT4[i];
            }
        }

        // Material @384 (floats 96..111)
        this.uniformData[96] = matDiffuse.r;
        this.uniformData[97] = matDiffuse.g;
        this.uniformData[98] = matDiffuse.b;
        this.uniformData[99] = matDiffuse.a;

        this.uniformData[100] = matAmbient.r;
        this.uniformData[101] = matAmbient.g;
        this.uniformData[102] = matAmbient.b;
        this.uniformData[103] = matAmbient.a;

        this.uniformData[104] = matSpecular.r;
        this.uniformData[105] = matSpecular.g;
        this.uniformData[106] = matSpecular.b;
        this.uniformData[107] = matSpecular.a;

        this.uniformData[108] = matEmissive.r;
        this.uniformData[109] = matEmissive.g;
        this.uniformData[110] = matEmissive.b;
        this.uniformData[111] = matEmissive.a;

        // matPower @448 + material source selectors @452..464
        this.uniformData[112] = matPower;
        view.setUint32(452, matDiffuseSrc >>> 0, true);
        view.setUint32(456, matAmbientSrc >>> 0, true);
        view.setUint32(460, matSpecularSrc >>> 0, true);
        view.setUint32(464, matEmissiveSrc >>> 0, true);

        // Per-stage texture matrices @480/544/608 (floats 120/136/152), identity when a
        // stage has no matrix so a stale flags/matrix pair can't leak. The transform flags
        // ride stages[N].w. Matrices are D3D row-major floats written as-is (same
        // convention as mvp/world).
        for (let stage = 0; stage < MAX_FFP_TEX_MATRICES; stage++) {
            const matIdx = 120 + stage * 16;
            const m = texMatrices ? texMatrices[stage] : null;
            if (m && m.length >= 16) {
                for (let i = 0; i < 16; i++) {
                    this.uniformData[matIdx + i] = m[i];
                }
            } else {
                for (let i = 0; i < 16; i++) {
                    this.uniformData[matIdx + i] = this.IDENTITY_MAT4[i];
                }
            }
        }

        // World×View matrix for camera-space texgen @672 (floats 168..183). Identity when
        // absent so a stale worldView can't leak camera-space coords into a passthrough draw.
        const worldViewIdx = 168;
        if (worldViewMatrix && worldViewMatrix.length >= 16) {
            for (let i = 0; i < 16; i++) {
                this.uniformData[worldViewIdx + i] = worldViewMatrix[i];
            }
        } else {
            for (let i = 0; i < 16; i++) {
                this.uniformData[worldViewIdx + i] = this.IDENTITY_MAT4[i];
            }
        }

        // clipPlaneEnable @736 (u32 word 184) — MUST stay in lockstep with the WGSL Uniforms
        // struct field of the same name (shader-generator.ts). The plane coefficients live in
        // the device-global binding-6 buffer; only this per-draw enable mask rides the slot.
        view.setUint32(736, clipPlaneEnable >>> 0, true);

        // OPTIMIZATION: Check if uniform data is identical to last written slot in this frame.
        // This is extremely common for batches of sprites/UI elements.
        if (this.lastUniformOffset !== -1 && this.lastUniformFrame === this.currentFrameIndex) {
            let match = true;
            for (let i = 0; i < this.uniformData.length; i++) { // full slot (slotSize / 4 floats)
                if (this.uniformData[i] !== this.lastUniformData[i]) {
                    match = false;
                    break;
                }
            }
            if (match) {
                return this.lastUniformOffset;
            }
        }

        // OPTIMIZATION: Write to CPU staging buffer instead of direct writeBuffer.
        // This eliminates thousands of tiny async GPU calls per frame.
        // The data is flushed to GPU in flushUniforms() which is called during flush().
        const staging = this.uniformStagingBuffers[this.currentFrameIndex];
        staging.set(this.uniformDataBytes, offset);
        
        // Update cache
        this.lastUniformData.set(this.uniformData);
        this.lastUniformOffset = offset;
        this.lastUniformFrame = this.currentFrameIndex;
        
        this.uniformRingOffsets[this.currentFrameIndex] = offset + this.uniformAlignment;

        return offset;
    }

    /**
     * Rotate to next frame - called at end of frame
     */
    /**
     * Get per-frame vertex ring buffer usage (call before nextFrame to get current frame stats)
     */
    getFrameVertexUsage(): { bytes: number; percent: number } {
        const offset = this.vertexRingOffsets[this.currentFrameIndex];
        return { bytes: offset, percent: (offset / this.ringBufferSize) * 100 };
    }

    /** Current-frame high-water offsets across all rings (call BEFORE nextFrame).
     *  Diagnoses per-frame capacity exhaustion: an offset at/near its size means
     *  tail draws of the frame hit the overflow paths. */
    getFrameUsage(): {
        v: number; i: number; u: number; l: number; s: number;
        vSize: number; uSize: number; sSize: number; lightsOverflow: number;
    } {
        const fi = this.currentFrameIndex;
        return {
            v: this.vertexRingOffsets[fi],
            i: this.indexRingOffsets[fi],
            u: this.uniformRingOffsets[fi],
            l: this.lightsRingOffsets[fi],
            s: this.storageRingOffsets[fi],
            vSize: this.ringBufferSize,
            uSize: this.uniformBufferSize,
            sSize: this.storageBufferSize,
            lightsOverflow: this.lightsOverflowCount,
        };
    }

    nextFrame(): void {
        // Reset warn throttle buckets for next frame
        this.lastVertexWarnBucket = 0;
        this.lastIndexWarnBucket = 0;
        this.lightsOverflowWarnedThisFrame = false;

        this.currentFrameIndex = (this.currentFrameIndex + 1) % this.ringBufferCount;
        this.vertexRingOffsets[this.currentFrameIndex] = 0;
        this.indexRingOffsets[this.currentFrameIndex] = 0;
        this.vertexUploadWindows[this.currentFrameIndex].reset();
        this.indexUploadWindows[this.currentFrameIndex].reset();
        this.uniformRingOffsets[this.currentFrameIndex] = 0;
        this.uniformDirtyOffsets[this.currentFrameIndex] = 0;
        this.lightsRingOffsets[this.currentFrameIndex] = 0;
        this.lightsDirtyOffsets[this.currentFrameIndex] = 0;
        this.storageRingOffsets[this.currentFrameIndex] = 0;
        this.storageDirtyOffsets[this.currentFrameIndex] = 0;

        // invalidate the uniform dedup cache. `lastUniformFrame` stores a
        // RING INDEX, which aliases every ringBufferCount frames — a stale cached
        // offset from the previous lap of this buffer would be handed to a draw while
        // this frame's allocations march from 0 toward (and over) that slot, rewriting
        // it before the draw's pass executes → wrong uniforms for one frame → the
        // random one-frame surface flicker (HP hunt 2026-06-11).
        this.lastUniformOffset = -1;
        this.lastUniformFrame = -1;
        this.lastDrawUniformIndex = -1;
        this.lastDrawUniformFrame = -1;
    }

    /**
     * Destroy all buffers
     */
    destroy(): void {
        for (const buffer of this.vertexRingBuffers) {
            buffer.destroy();
        }
        for (const buffer of this.indexRingBuffers) {
            buffer.destroy();
        }
        for (const buffer of this.uniformRingBuffers) {
            buffer.destroy();
        }
        for (const buffer of this.lightsRingBuffers) {
            buffer.destroy();
        }
        for (const buffer of this.storageRingBuffers) {
            buffer.destroy();
        }
        this.vertexRingBuffers = [];
        this.indexRingBuffers = [];
        this.uniformRingBuffers = [];
        this.lightsRingBuffers = [];
        this.storageRingBuffers = [];
        this.vertexUploadWindows = [];
        this.indexUploadWindows = [];
    }
}
