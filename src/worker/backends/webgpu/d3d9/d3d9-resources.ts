/**
 * Data-Oriented Resource Stores for D3D9
 *
 * Structure-of-Arrays (SoA) layout for cache-efficient access patterns.
 * Each store manages one resource type with generation counters for safety.
 */

import {
    getD3DTextureLayout,
} from "../shared/texture-formats";
import { noteGuestBufferWrite, writeDirtyRange } from "../buffer-upload";
import { d3d9WasmArena } from "./d3d9-wasm-arena";

/**
 * `[dirtyStart, dirtyEnd)` accumulates the union of the locked ranges since the last upload
 * (empty = clean) so an upload costs the lock's size rather than the buffer's — see
 * buffer-upload.ts. `setDirty(i, true)` means the WHOLE buffer, which is what every caller
 * that forces a re-upload (device loss, ring rewind, creation) actually means, so those paths
 * keep working unchanged and cannot silently degrade into a partial upload.
 */

// Vertex Buffer Store - SoA layout
export class VertexBufferStore {
    // Capacity management
    private capacity: number;
    private count = 0;
    private freeList: number[] = [];

    // SoA arrays
    private sizes: Uint32Array;
    private fvfs: Uint32Array;
    private pools: Uint32Array;
    private data: (Uint8Array | undefined)[];
    private gpuBuffers: (GPUBuffer | null)[];
    private lockedPtrs: Int32Array;    // -1 = not locked
    private lockedSizes: Uint32Array;
    private lockedOffsets: Uint32Array;
    private guestPtrs: Int32Array;     // HEAP backing for Lock/Unlock
    private dirtyFlags: Uint8Array;    // Boolean as byte
    private dirtyStarts: Uint32Array;  // union of locked ranges since last upload
    private dirtyEnds: Uint32Array;    // exclusive; end <= start = clean
    private generations: Uint16Array;

    // Handle mapping
    private handleToIndex: Map<number, number> = new Map();

    constructor(initialCapacity = 256) {
        this.capacity = initialCapacity;
        this.sizes = new Uint32Array(initialCapacity);
        this.fvfs = new Uint32Array(initialCapacity);
        this.pools = new Uint32Array(initialCapacity);
        this.data = new Array(initialCapacity);
        this.gpuBuffers = new Array(initialCapacity).fill(null);
        this.lockedPtrs = new Int32Array(initialCapacity).fill(-1);
        this.lockedSizes = new Uint32Array(initialCapacity);
        this.lockedOffsets = new Uint32Array(initialCapacity);
        this.guestPtrs = new Int32Array(initialCapacity).fill(-1);
        this.dirtyFlags = new Uint8Array(initialCapacity);
        this.dirtyStarts = new Uint32Array(initialCapacity);
        this.dirtyEnds = new Uint32Array(initialCapacity);
        this.generations = new Uint16Array(initialCapacity);
    }

    create(handle: number, size: number, fvf: number, guestPtr: number, pool = 0): number {
        let index: number;
        if (this.freeList.length > 0) {
            index = this.freeList.pop()!;
        } else {
            if (this.count >= this.capacity) {
                this.grow();
            }
            index = this.count++;
        }

        this.sizes[index] = size;
        this.fvfs[index] = fvf;
        this.pools[index] = pool >>> 0;
        this.data[index] = new Uint8Array(size);
        this.gpuBuffers[index] = null;
        this.lockedPtrs[index] = -1;
        this.lockedSizes[index] = 0;
        this.lockedOffsets[index] = 0;
        this.guestPtrs[index] = guestPtr;
        this.dirtyFlags[index] = 1;
        this.dirtyStarts[index] = 0;
        this.dirtyEnds[index] = size;

        const gen = this.generations[index];
        const packed = (gen << 16) | index;
        this.handleToIndex.set(handle, packed);
        return index;
    }

    getIndex(handle: number): number | null {
        const packed = this.handleToIndex.get(handle);
        if (packed === undefined) return null;
        const index = packed & 0xFFFF;
        const expectedGen = (packed >> 16) & 0xFFFF;
        if (this.generations[index] !== expectedGen) {
            this.handleToIndex.delete(handle);
            return null;
        }
        return index;
    }

    release(handle: number): { gpuBuffer: GPUBuffer | null; guestPtr: number } | null {
        const packed = this.handleToIndex.get(handle);
        if (packed === undefined) return null;
        const index = packed & 0xFFFF;
        const expectedGen = (packed >> 16) & 0xFFFF;
        if (this.generations[index] !== expectedGen) {
            this.handleToIndex.delete(handle);
            return null;
        }

        const gpuBuffer = this.gpuBuffers[index];
        const guestPtr = this.guestPtrs[index];
        this.data[index] = undefined;
        this.gpuBuffers[index] = null;
        this.guestPtrs[index] = -1;
        this.generations[index] = (this.generations[index] + 1) & 0xFFFF;
        this.freeList.push(index);
        this.handleToIndex.delete(handle);

        return { gpuBuffer, guestPtr };
    }

    // Getters for individual fields
    getSize(index: number): number { return this.sizes[index]; }
    getPool(index: number): number { return this.pools[index]; }
    getFvf(index: number): number { return this.fvfs[index]; }
    getData(index: number): Uint8Array | undefined { return this.data[index]; }
    getGpuBuffer(index: number): GPUBuffer | null { return this.gpuBuffers[index]; }
    getGuestPtr(index: number): number { return this.guestPtrs[index]; }
    isDirty(index: number): boolean { return this.dirtyFlags[index] !== 0; }
    isLocked(index: number): boolean { return this.lockedPtrs[index] !== -1; }
    getDirtyStart(index: number): number { return this.dirtyStarts[index]; }
    getDirtyEnd(index: number): number { return this.dirtyEnds[index]; }

    // Setters
    setGpuBuffer(index: number, buffer: GPUBuffer): void { this.gpuBuffers[index] = buffer; }
    /** `true` dirties the WHOLE buffer — the only thing a forced re-upload can safely mean. */
    setDirty(index: number, dirty: boolean): void {
        this.dirtyFlags[index] = dirty ? 1 : 0;
        this.dirtyStarts[index] = 0;
        this.dirtyEnds[index] = dirty ? this.sizes[index] : 0;
    }

    /**
     * Device loss: the GPU copies are dead handles, the `data` shadow is not. Forgetting the
     * buffers and re-raising `dirty` is the whole restore — the upload path re-creates and
     * re-fills each buffer from the shadow the next time it is drawn with.
     * Returns how many live entries were dropped.
     */
    dropGpuResources(): number {
        let n = 0;
        for (let i = 0; i < this.count; i++) {
            if (this.gpuBuffers[i]) { this.gpuBuffers[i] = null; n++; }
            // D3DPOOL_DEFAULT bytes are lost with the device.  MANAGED/SYSTEMMEM
            // retain their CPU shadow and are uploaded again normally.
            if (this.pools[i] === 0) this.data[i]?.fill(0);
            this.setDirty(i, true);
        }
        return n;
    }

    // Lock operations — returns guest pointer for the locked region
    lock(index: number, offset: number, size: number): number {
        const guestBase = this.guestPtrs[index];
        if (guestBase < 0) return -1;
        this.lockedPtrs[index] = guestBase + offset;
        this.lockedSizes[index] = size;
        this.lockedOffsets[index] = offset;
        return guestBase + offset;
    }

    unlock(index: number, memory: Uint8Array): void {
        const guestBase = this.guestPtrs[index];
        if (guestBase < 0 || this.lockedPtrs[index] === -1) return;
        const size = this.lockedSizes[index];
        const offset = this.lockedOffsets[index];
        const data = this.data[index];
        if (data) {
            data.set(memory.subarray(guestBase + offset, guestBase + offset + size), offset);
        }
        this.lockedPtrs[index] = -1;
        this.lockedSizes[index] = 0;
        this.lockedOffsets[index] = 0;
        noteGuestBufferWrite("d3d9", size);
        if (this.dirtyFlags[index] && this.dirtyEnds[index] > this.dirtyStarts[index]) {
            this.dirtyStarts[index] = Math.min(this.dirtyStarts[index], offset);
            this.dirtyEnds[index] = Math.max(this.dirtyEnds[index], offset + size);
        } else {
            this.dirtyStarts[index] = offset;
            this.dirtyEnds[index] = offset + size;
        }
        this.dirtyFlags[index] = 1;
    }

    // Batch upload all dirty buffers
    uploadDirty(device: GPUDevice, queue: GPUQueue): number {
        let uploaded = 0;
        for (let i = 0; i < this.count; i++) {
            const data = this.data[i];
            if (this.dirtyFlags[i] && data) {
                // A freshly created buffer holds nothing, so its first upload is whole
                // regardless of how small the dirty range is.
                let whole = false;
                if (!this.gpuBuffers[i]) {
                    this.gpuBuffers[i] = device.createBuffer({
                        size: (this.sizes[i] + 3) & ~3,
                        // COPY_SRC: the executor's robustness padding copies out of a slot a
                        // draw outruns (d3d9-backend-executor planVertexRangePadding).
                        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
                    });
                    whole = true;
                }
                writeDirtyRange(queue, this.gpuBuffers[i]!, data,
                    whole ? 0 : this.dirtyStarts[i], whole ? this.sizes[i] : this.dirtyEnds[i], "d3d9", whole);
                this.setDirty(i, false);
                uploaded++;
            }
        }
        return uploaded;
    }

    private grow(): void {
        const newCapacity = this.capacity * 2;

        const newSizes = new Uint32Array(newCapacity);
        newSizes.set(this.sizes);
        this.sizes = newSizes;

        const newFvfs = new Uint32Array(newCapacity);
        newFvfs.set(this.fvfs);
        this.fvfs = newFvfs;

        const newPools = new Uint32Array(newCapacity);
        newPools.set(this.pools);
        this.pools = newPools;

        const newData = new Array(newCapacity);
        for (let i = 0; i < this.data.length; i++) newData[i] = this.data[i];
        this.data = newData;

        const newGpuBuffers = new Array(newCapacity).fill(null);
        for (let i = 0; i < this.gpuBuffers.length; i++) newGpuBuffers[i] = this.gpuBuffers[i];
        this.gpuBuffers = newGpuBuffers;

        const newLockedPtrs = new Int32Array(newCapacity).fill(-1);
        newLockedPtrs.set(this.lockedPtrs);
        this.lockedPtrs = newLockedPtrs;

        const newLockedSizes = new Uint32Array(newCapacity);
        newLockedSizes.set(this.lockedSizes);
        this.lockedSizes = newLockedSizes;

        const newLockedOffsets = new Uint32Array(newCapacity);
        newLockedOffsets.set(this.lockedOffsets);
        this.lockedOffsets = newLockedOffsets;

        const newGuestPtrs = new Int32Array(newCapacity).fill(-1);
        newGuestPtrs.set(this.guestPtrs);
        this.guestPtrs = newGuestPtrs;

        const newDirtyFlags = new Uint8Array(newCapacity);
        newDirtyFlags.set(this.dirtyFlags);
        this.dirtyFlags = newDirtyFlags;

        const newDirtyStarts = new Uint32Array(newCapacity);
        newDirtyStarts.set(this.dirtyStarts);
        this.dirtyStarts = newDirtyStarts;

        const newDirtyEnds = new Uint32Array(newCapacity);
        newDirtyEnds.set(this.dirtyEnds);
        this.dirtyEnds = newDirtyEnds;

        const newGenerations = new Uint16Array(newCapacity);
        newGenerations.set(this.generations);
        this.generations = newGenerations;

        this.capacity = newCapacity;
    }

    // Debug export: get all vertex buffers info
    getAllDebugInfo(): Array<{
        handle: number;
        size: number;
        fvf: number;
        isDirty: boolean;
        isLocked: boolean;
        hasGpuBuffer: boolean;
    }> {
        const result: Array<{
            handle: number;
            size: number;
            fvf: number;
            isDirty: boolean;
            isLocked: boolean;
            hasGpuBuffer: boolean;
        }> = [];
        
        for (const [handle, packed] of this.handleToIndex.entries()) {
            const index = packed & 0xFFFF;
            const expectedGen = (packed >> 16) & 0xFFFF;
            if (this.generations[index] !== expectedGen) continue;
            if (this.data[index] === undefined) continue;
            
            result.push({
                handle,
                size: this.sizes[index],
                fvf: this.fvfs[index],
                isDirty: this.dirtyFlags[index] !== 0,
                isLocked: this.lockedPtrs[index] !== -1,
                hasGpuBuffer: this.gpuBuffers[index] !== null,
            });
        }
        
        return result;
    }
}

// Index Buffer Store - SoA layout
export class IndexBufferStore {
    private capacity: number;
    private count = 0;
    private freeList: number[] = [];

    private sizes: Uint32Array;
    private formats: Uint32Array;
    private pools: Uint32Array;
    private data: (Uint8Array | undefined)[];
    private gpuBuffers: (GPUBuffer | null)[];
    private lockedPtrs: Int32Array;
    private lockedSizes: Uint32Array;
    private lockedOffsets: Uint32Array;
    private guestPtrs: Int32Array;
    private dirtyFlags: Uint8Array;
    private dirtyStarts: Uint32Array;
    private dirtyEnds: Uint32Array;
    private generations: Uint16Array;

    private handleToIndex: Map<number, number> = new Map();

    constructor(initialCapacity = 256) {
        this.capacity = initialCapacity;
        this.sizes = new Uint32Array(initialCapacity);
        this.formats = new Uint32Array(initialCapacity);
        this.pools = new Uint32Array(initialCapacity);
        this.data = new Array(initialCapacity);
        this.gpuBuffers = new Array(initialCapacity).fill(null);
        this.lockedPtrs = new Int32Array(initialCapacity).fill(-1);
        this.lockedSizes = new Uint32Array(initialCapacity);
        this.lockedOffsets = new Uint32Array(initialCapacity);
        this.guestPtrs = new Int32Array(initialCapacity).fill(-1);
        this.dirtyFlags = new Uint8Array(initialCapacity);
        this.dirtyStarts = new Uint32Array(initialCapacity);
        this.dirtyEnds = new Uint32Array(initialCapacity);
        this.generations = new Uint16Array(initialCapacity);
    }

    create(handle: number, size: number, format: number, guestPtr: number, pool = 0): number {
        let index: number;
        if (this.freeList.length > 0) {
            index = this.freeList.pop()!;
        } else {
            if (this.count >= this.capacity) {
                this.grow();
            }
            index = this.count++;
        }

        this.sizes[index] = size;
        this.formats[index] = format;
        this.pools[index] = pool >>> 0;
        this.data[index] = new Uint8Array(size);
        this.gpuBuffers[index] = null;
        this.lockedPtrs[index] = -1;
        this.lockedSizes[index] = 0;
        this.lockedOffsets[index] = 0;
        this.guestPtrs[index] = guestPtr;
        this.dirtyFlags[index] = 1;
        this.dirtyStarts[index] = 0;
        this.dirtyEnds[index] = size;

        const gen = this.generations[index];
        const packed = (gen << 16) | index;
        this.handleToIndex.set(handle, packed);
        return index;
    }

    getIndex(handle: number): number | null {
        const packed = this.handleToIndex.get(handle);
        if (packed === undefined) return null;
        const index = packed & 0xFFFF;
        const expectedGen = (packed >> 16) & 0xFFFF;
        if (this.generations[index] !== expectedGen) {
            this.handleToIndex.delete(handle);
            return null;
        }
        return index;
    }

    release(handle: number): { gpuBuffer: GPUBuffer | null; guestPtr: number } | null {
        const packed = this.handleToIndex.get(handle);
        if (packed === undefined) return null;
        const index = packed & 0xFFFF;
        const expectedGen = (packed >> 16) & 0xFFFF;
        if (this.generations[index] !== expectedGen) {
            this.handleToIndex.delete(handle);
            return null;
        }

        const gpuBuffer = this.gpuBuffers[index];
        const guestPtr = this.guestPtrs[index];
        this.data[index] = undefined;
        this.gpuBuffers[index] = null;
        this.guestPtrs[index] = -1;
        this.generations[index] = (this.generations[index] + 1) & 0xFFFF;
        this.freeList.push(index);
        this.handleToIndex.delete(handle);

        return { gpuBuffer, guestPtr };
    }

    getSize(index: number): number { return this.sizes[index]; }
    getPool(index: number): number { return this.pools[index]; }
    getFormat(index: number): number { return this.formats[index]; }
    getData(index: number): Uint8Array | undefined { return this.data[index]; }
    getGpuBuffer(index: number): GPUBuffer | null { return this.gpuBuffers[index]; }
    getGuestPtr(index: number): number { return this.guestPtrs[index]; }
    isDirty(index: number): boolean { return this.dirtyFlags[index] !== 0; }
    getDirtyStart(index: number): number { return this.dirtyStarts[index]; }
    getDirtyEnd(index: number): number { return this.dirtyEnds[index]; }

    setGpuBuffer(index: number, buffer: GPUBuffer): void { this.gpuBuffers[index] = buffer; }
    /** `true` dirties the WHOLE buffer — see VertexBufferStore.setDirty. */
    setDirty(index: number, dirty: boolean): void {
        this.dirtyFlags[index] = dirty ? 1 : 0;
        this.dirtyStarts[index] = 0;
        this.dirtyEnds[index] = dirty ? this.sizes[index] : 0;
    }

    /** Device loss — see VertexBufferStore.dropGpuResources. */
    dropGpuResources(): number {
        let n = 0;
        for (let i = 0; i < this.count; i++) {
            if (this.gpuBuffers[i]) { this.gpuBuffers[i] = null; n++; }
            if (this.pools[i] === 0) this.data[i]?.fill(0);
            this.setDirty(i, true);
        }
        return n;
    }

    lock(index: number, offset: number, size: number): number {
        const guestBase = this.guestPtrs[index];
        if (guestBase < 0) return -1;
        this.lockedPtrs[index] = guestBase + offset;
        this.lockedSizes[index] = size;
        this.lockedOffsets[index] = offset;
        return guestBase + offset;
    }

    unlock(index: number, memory: Uint8Array): void {
        const guestBase = this.guestPtrs[index];
        if (guestBase < 0 || this.lockedPtrs[index] === -1) return;
        const size = this.lockedSizes[index];
        const offset = this.lockedOffsets[index];
        const data = this.data[index];
        if (data) {
            data.set(memory.subarray(guestBase + offset, guestBase + offset + size), offset);
        }
        this.lockedPtrs[index] = -1;
        this.lockedSizes[index] = 0;
        this.lockedOffsets[index] = 0;
        noteGuestBufferWrite("d3d9", size);
        if (this.dirtyFlags[index] && this.dirtyEnds[index] > this.dirtyStarts[index]) {
            this.dirtyStarts[index] = Math.min(this.dirtyStarts[index], offset);
            this.dirtyEnds[index] = Math.max(this.dirtyEnds[index], offset + size);
        } else {
            this.dirtyStarts[index] = offset;
            this.dirtyEnds[index] = offset + size;
        }
        this.dirtyFlags[index] = 1;
    }

    uploadDirty(device: GPUDevice, queue: GPUQueue): number {
        let uploaded = 0;
        for (let i = 0; i < this.count; i++) {
            const data = this.data[i];
            if (this.dirtyFlags[i] && data) {
                let whole = false;
                if (!this.gpuBuffers[i]) {
                    this.gpuBuffers[i] = device.createBuffer({
                        size: (this.sizes[i] + 3) & ~3,
                        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
                    });
                    whole = true;
                }
                writeDirtyRange(queue, this.gpuBuffers[i]!, data,
                    whole ? 0 : this.dirtyStarts[i], whole ? this.sizes[i] : this.dirtyEnds[i], "d3d9", whole);
                this.setDirty(i, false);
                uploaded++;
            }
        }
        return uploaded;
    }

    private grow(): void {
        const newCapacity = this.capacity * 2;

        const newSizes = new Uint32Array(newCapacity);
        newSizes.set(this.sizes);
        this.sizes = newSizes;

        const newFormats = new Uint32Array(newCapacity);
        newFormats.set(this.formats);
        this.formats = newFormats;

        const newPools = new Uint32Array(newCapacity);
        newPools.set(this.pools);
        this.pools = newPools;

        const newData = new Array(newCapacity);
        for (let i = 0; i < this.data.length; i++) newData[i] = this.data[i];
        this.data = newData;

        const newGpuBuffers = new Array(newCapacity).fill(null);
        for (let i = 0; i < this.gpuBuffers.length; i++) newGpuBuffers[i] = this.gpuBuffers[i];
        this.gpuBuffers = newGpuBuffers;

        const newLockedPtrs = new Int32Array(newCapacity).fill(-1);
        newLockedPtrs.set(this.lockedPtrs);
        this.lockedPtrs = newLockedPtrs;

        const newLockedSizes = new Uint32Array(newCapacity);
        newLockedSizes.set(this.lockedSizes);
        this.lockedSizes = newLockedSizes;

        const newLockedOffsets = new Uint32Array(newCapacity);
        newLockedOffsets.set(this.lockedOffsets);
        this.lockedOffsets = newLockedOffsets;

        const newGuestPtrs = new Int32Array(newCapacity).fill(-1);
        newGuestPtrs.set(this.guestPtrs);
        this.guestPtrs = newGuestPtrs;

        const newDirtyFlags = new Uint8Array(newCapacity);
        newDirtyFlags.set(this.dirtyFlags);
        this.dirtyFlags = newDirtyFlags;

        const newDirtyStarts = new Uint32Array(newCapacity);
        newDirtyStarts.set(this.dirtyStarts);
        this.dirtyStarts = newDirtyStarts;

        const newDirtyEnds = new Uint32Array(newCapacity);
        newDirtyEnds.set(this.dirtyEnds);
        this.dirtyEnds = newDirtyEnds;

        const newGenerations = new Uint16Array(newCapacity);
        newGenerations.set(this.generations);
        this.generations = newGenerations;

        this.capacity = newCapacity;
    }

    // Debug export: get all index buffers info
    getAllDebugInfo(): Array<{
        handle: number;
        size: number;
        format: number;
        isDirty: boolean;
        isLocked: boolean;
        hasGpuBuffer: boolean;
    }> {
        const result: Array<{
            handle: number;
            size: number;
            format: number;
            isDirty: boolean;
            isLocked: boolean;
            hasGpuBuffer: boolean;
        }> = [];
        
        for (const [handle, packed] of this.handleToIndex.entries()) {
            const index = packed & 0xFFFF;
            const expectedGen = (packed >> 16) & 0xFFFF;
            if (this.generations[index] !== expectedGen) continue;
            if (this.data[index] === undefined) continue;
            
            result.push({
                handle,
                size: this.sizes[index],
                format: this.formats[index],
                isDirty: this.dirtyFlags[index] !== 0,
                isLocked: this.lockedPtrs[index] !== -1,
                hasGpuBuffer: this.gpuBuffers[index] !== null,
            });
        }
        
        return result;
    }
}

// Texture Store - SoA layout
export class TextureStore {
    private capacity: number;
    private count = 0;
    private freeList: number[] = [];

    private widths: Uint32Array;
    private heights: Uint32Array;
    private levels: Uint32Array;
    /** D3DPOOL for each guest texture: DEFAULT contents are not recoverable after loss. */
    private pools: Uint32Array;
    // Reverse map (index → handle/texPtr) so upload paths that only hold an index can find the
    // device-side mip data, which is keyed by texPtr. Overwritten on every create() of an index.
    private handles: number[] = [];
    private formats: Uint32Array;
    private data: (Uint8Array | undefined)[];
    private gpuTextures: (GPUTexture | null)[];
    private views: (GPUTextureView | null)[];
    private lockedPtrs: Int32Array;
    private guestPtrs: Int32Array;
    private pitches: Uint32Array;
    private dirtyFlags: Uint8Array;
    private generations: Uint16Array;
    // Split-storage coherence: see guestCopyIsStale.
    private dataSerials: Uint32Array;
    private guestSerials: Uint32Array;
    // 1 = render-target texture (rendered into, no guest pixel upload). See markRenderTarget.
    private rtFlags: Uint8Array;
    // 1 = cube texture (6 array layers; sampling view is dimension:"cube"). See markCube.
    private cubeFlags: Uint8Array;

    private handleToIndex: Map<number, number> = new Map();

    constructor(initialCapacity = 256) {
        this.capacity = initialCapacity;
        this.widths = new Uint32Array(initialCapacity);
        this.heights = new Uint32Array(initialCapacity);
        this.levels = new Uint32Array(initialCapacity);
        this.pools = new Uint32Array(initialCapacity);
        this.formats = new Uint32Array(initialCapacity);
        this.data = new Array(initialCapacity);
        this.gpuTextures = new Array(initialCapacity).fill(null);
        this.views = new Array(initialCapacity).fill(null);
        this.lockedPtrs = new Int32Array(initialCapacity).fill(-1);
        this.guestPtrs = new Int32Array(initialCapacity).fill(-1);
        this.pitches = new Uint32Array(initialCapacity);
        this.dirtyFlags = new Uint8Array(initialCapacity);
        this.generations = new Uint16Array(initialCapacity);
        this.dataSerials = new Uint32Array(initialCapacity);
        this.guestSerials = new Uint32Array(initialCapacity);
        this.rtFlags = new Uint8Array(initialCapacity);
        this.cubeFlags = new Uint8Array(initialCapacity);
    }

    create(handle: number, width: number, height: number, levels: number, format: number, guestPtr: number, pool = 0): number {
        let index: number;
        if (this.freeList.length > 0) {
            index = this.freeList.pop()!;
        } else {
            if (this.count >= this.capacity) {
                this.grow();
            }
            index = this.count++;
        }

        // Pitch = block-row stride for compressed (DXT/BC) formats, width*4 for
        // plain ARGB. This is the faithful D3D9 LockRect pitch AND the stride
        // ensureDxtTexture reads the blocks back at. Using width*4 for DXT1
        // (real pitch = width*2) read every other block row → top-half squish.
        this.widths[index] = width;
        this.heights[index] = height;
        this.levels[index] = levels;
        this.pools[index] = pool >>> 0;
        this.handles[index] = handle;
        this.formats[index] = format;
        const layout = getD3DTextureLayout(format, width, height);
        this.data[index] = new Uint8Array(layout.bytes);
        this.gpuTextures[index] = null;
        this.views[index] = null;
        this.lockedPtrs[index] = -1;
        this.guestPtrs[index] = guestPtr;
        this.pitches[index] = layout.pitch;
        this.dirtyFlags[index] = 1;
        // Fresh zeroed `data` and a fresh guest allocation: neither holds pixels, and a
        // recycled index must not inherit the previous texture's agreement.
        this.dataSerials[index] = 0;
        this.guestSerials[index] = 0;
        this.rtFlags[index] = 0;
        this.cubeFlags[index] = 0;
        // The arena keeps cube metadata in a separate id-indexed table. A recycled
        // TextureStore slot must clear that table before the id can denote a 2-D texture.
        d3d9WasmArena.markTextureCube(index + 1, false);

        const gen = this.generations[index];
        const packed = (gen << 16) | index;
        this.handleToIndex.set(handle, packed);
        return index;
    }

    getIndex(handle: number): number | null {
        const packed = this.handleToIndex.get(handle);
        if (packed === undefined) return null;
        const index = packed & 0xFFFF;
        const expectedGen = (packed >> 16) & 0xFFFF;
        if (this.generations[index] !== expectedGen) {
            this.handleToIndex.delete(handle);
            return null;
        }
        return index;
    }

    release(handle: number): { gpuTexture: GPUTexture | null; guestPtr: number } | null {
        const packed = this.handleToIndex.get(handle);
        if (packed === undefined) return null;
        const index = packed & 0xFFFF;
        const expectedGen = (packed >> 16) & 0xFFFF;
        if (this.generations[index] !== expectedGen) {
            this.handleToIndex.delete(handle);
            return null;
        }

        const gpuTexture = this.gpuTextures[index];
        const guestPtr = this.guestPtrs[index];
        this.data[index] = undefined;
        this.gpuTextures[index] = null;
        this.views[index] = null;
        this.guestPtrs[index] = -1;
        // Clear the arena's one-based cube flag at destruction as well as on reuse. This
        // prevents a released cube id from remaining cube-shaped while still bound in a
        // later draw before the guest replaces the sampler binding.
        d3d9WasmArena.markTextureCube(index + 1, false);
        this.generations[index] = (this.generations[index] + 1) & 0xFFFF;
        this.freeList.push(index);
        this.handleToIndex.delete(handle);

        return { gpuTexture, guestPtr };
    }

    getWidth(index: number): number { return this.widths[index]; }
    getHeight(index: number): number { return this.heights[index]; }
    getLevels(index: number): number { return this.levels[index]; }
    getPool(index: number): number { return this.pools[index]; }
    getHandle(index: number): number { return this.handles[index]; }
    getFormat(index: number): number { return this.formats[index]; }
    getData(index: number): Uint8Array | undefined { return this.data[index]; }
    getGpuTexture(index: number): GPUTexture | null { return this.gpuTextures[index]; }
    getView(index: number): GPUTextureView | null { return this.views[index]; }
    getPitch(index: number): number { return this.pitches[index]; }
    isDirty(index: number): boolean { return this.dirtyFlags[index] !== 0; }
    isLocked(index: number): boolean { return this.lockedPtrs[index] !== -1; }
    getLockedPtr(index: number): number { return this.lockedPtrs[index]; }

    /**
     * The level-0 lock whose staging bytes contain `addr`, if any.
     *
     * A guest that hands a LockRect pointer to an outside decoder (Bink's
     * BinkCopyToBuffer) is writing into a buffer its own UnlockRect will upload — so the
     * write IS visible on a GPU presenter, unlike a bare heap buffer. Nothing else can
     * tell those two apart from the pointer alone.
     */
    findLockedByPointer(addr: number): { pitch: number; width: number; height: number } | null {
        const ptr = addr >>> 0;
        if (!ptr) return null;
        for (const [, packed] of this.handleToIndex.entries()) {
            const index = packed & 0xFFFF;
            const expectedGen = (packed >> 16) & 0xFFFF;
            if (this.generations[index] !== expectedGen) continue;
            const base = this.lockedPtrs[index];
            if (base < 0) continue;
            const pitch = this.pitches[index];
            const height = this.heights[index];
            // Rows, not height: a block-compressed level holds height/4 block rows, and
            // claiming pitch*height would report a hit for pointers up to 4x past the
            // texture's own allocation. Same source of truth as create()/unlock().
            const rows = getD3DTextureLayout(this.formats[index], this.widths[index], height).rows;
            const end = (base >>> 0) + pitch * rows;
            if (ptr >= (base >>> 0) && ptr < end) {
                return { pitch, width: this.widths[index], height };
            }
        }
        return null;
    }

    setGpuTexture(index: number, texture: GPUTexture, view: GPUTextureView): void {
        this.gpuTextures[index] = texture;
        this.views[index] = view;
    }
    /**
     * `dirty` means "the CPU copy changed and the GPU must be re-uploaded from it", which is
     * also exactly when the guest buffer stops mirroring `data` — so this is the one
     * chokepoint that bumps the data generation. Routing every `data` writer through it is
     * what makes publish-on-lock complete without each writer knowing the mechanism exists.
     */
    setDirty(index: number, dirty: boolean): void {
        this.dirtyFlags[index] = dirty ? 1 : 0;
        if (dirty) this.noteDataWritten(index);
    }

    /**
     * `data[index]` changed, so the guest buffer no longer mirrors it. Separate from
     * `setDirty` because a GPU readback lands in `data` WITHOUT the texture needing to be
     * uploaded back to the GPU — raising the upload flag there would push the pixels we just
     * downloaded straight back up every frame.
     */
    noteDataWritten(index: number): void {
        this.dataSerials[index] = (this.dataSerials[index] + 1) >>> 0;
    }

    /**
     * Device loss. A sampled texture keeps its `data` shadow and is restored by re-raising
     * `dirty`; a RENDER TARGET has no shadow, because its only copy was the lost texture.
     * That is the same thing real hardware does to a D3DPOOL_DEFAULT render target — the
     * contents are gone and the app redraws them — so it is left un-dirtied rather than
     * re-uploaded from a buffer that holds nothing.
     * Returns `{dropped, contentLost}` so the loss report can say what did NOT come back.
     */
    dropGpuResources(): { dropped: number; contentLost: number; contentLostHandles: number[] } {
        let dropped = 0, contentLost = 0;
        const contentLostHandles: number[] = [];
        for (let i = 0; i < this.count; i++) {
            if (this.gpuTextures[i]) { dropped++; }
            this.gpuTextures[i] = null;
            this.views[i] = null;
            const lost = this.rtFlags[i] !== 0 || this.pools[i] === 0;
            if (lost) {
                contentLost++;
                contentLostHandles.push(this.handles[i] ?? 0);
                // DEFAULT and render-target contents are not preserved by D3D9 device
                // loss.  Clear the CPU shadow too, so a later Lock cannot publish stale
                // pre-loss pixels back to the guest.
                this.data[i]?.fill(0);
                this.dataSerials[i] = (this.dataSerials[i] + 1) >>> 0;
                this.dirtyFlags[i] = 0;
            } else {
                // MANAGED/SYSTEMMEM can be restored from their CPU shadow.
                this.dirtyFlags[i] = 1;
            }
        }
        return { dropped, contentLost, contentLostHandles };
    }

    markRenderTarget(index: number): void { this.rtFlags[index] = 1; }
    isRenderTarget(index: number): boolean { return this.rtFlags[index] !== 0; }
    markCube(index: number): void { this.cubeFlags[index] = 1; }
    isCubeMap(index: number): boolean { return this.cubeFlags[index] !== 0; }

    /** Level-0 byte count: block rows for a compressed format, plain rows otherwise. */
    levelBytes(index: number): number {
        const rows = getD3DTextureLayout(
            this.formats[index], this.widths[index], this.heights[index]).rows;
        return this.pitches[index] * rows;
    }

    /**
     * The generation of `data[index]`, and the generation the guest buffer last mirrored.
     *
     * Storage here is SPLIT: `data` is the CPU copy every JS writer (GetRenderTargetData, a
     * GPU readback, UpdateTexture, a colour fill) lands in, while `guestPtrs` is the separate
     * HEAP buffer the guest gets a pointer to. Equal generations mean the guest buffer already
     * holds those bytes, so a Lock costs nothing; a difference is the only thing that makes a
     * publish necessary — this is DXVK's per-subresource `NeedsReadback` flag under another
     * name (d3d9_device.cpp:5037).
     */
    guestCopyIsStale(index: number): boolean {
        return this.guestSerials[index] !== this.dataSerials[index];
    }

    /**
     * Acquire the lock and, unless the caller says the old contents are not needed, publish
     * `data` into the guest buffer so the pointer we hand back addresses the current pixels.
     *
     * Without this the two halves of the split never meet: a readback populates `data` and
     * Lock returns a pointer to a buffer nobody wrote.
     */
    lock(index: number, memory: Uint8Array, opts: { publish: boolean } = { publish: true })
        : { ptr: number; pitch: number; published: boolean } | null {
        const guestBase = this.guestPtrs[index];
        if (guestBase < 0) return null;
        let published = false;
        const data = this.data[index];
        if (opts.publish && data && this.guestCopyIsStale(index)) {
            const bytes = Math.min(this.levelBytes(index), data.length);
            memory.set(data.subarray(0, bytes), guestBase);
            this.guestSerials[index] = this.dataSerials[index];
            published = true;
        }
        this.lockedPtrs[index] = guestBase;
        return { ptr: guestBase, pitch: this.pitches[index], published };
    }

    /**
     * Release the lock. `readOnly` is the app's promise that it wrote nothing, so the guest
     * bytes are not copied back — but they are also no longer trusted to match `data` (the app
     * may have scribbled through the pointer anyway), so the guest copy is marked stale and the
     * next Lock republishes. DXVK gates its dirty-box accumulation the same way
     * (d3d9_device.cpp:5157-5173).
     */
    unlock(
        index: number,
        memory: Uint8Array,
        opts: { readOnly?: boolean; noDirtyUpdate?: boolean } = {},
    ): void {
        const guestBase = this.guestPtrs[index];
        if (guestBase < 0 || this.lockedPtrs[index] === -1) return;
        this.lockedPtrs[index] = -1;
        if (opts.readOnly) {
            this.guestSerials[index] = (this.dataSerials[index] - 1) >>> 0;
            return;
        }
        const data = this.data[index];
        if (data) {
            // Compressed surfaces hold height/4 block rows, not `height` rows; with the
            // block-row pitch this avoids copying ~height*3/4 of adjacent guest memory.
            const bytes = this.levelBytes(index);
            data.set(memory.subarray(guestBase, guestBase + bytes));
        }
        if (!opts.noDirtyUpdate) this.setDirty(index, true);
        // The guest buffer IS what `data` was just set from, so it is in sync by construction.
        this.guestSerials[index] = this.dataSerials[index];
    }

    private grow(): void {
        const newCapacity = this.capacity * 2;

        const newWidths = new Uint32Array(newCapacity);
        newWidths.set(this.widths);
        this.widths = newWidths;

        const newHeights = new Uint32Array(newCapacity);
        newHeights.set(this.heights);
        this.heights = newHeights;

        const newLevels = new Uint32Array(newCapacity);
        newLevels.set(this.levels);
        this.levels = newLevels;

        const newPools = new Uint32Array(newCapacity);
        newPools.set(this.pools);
        this.pools = newPools;

        const newFormats = new Uint32Array(newCapacity);
        newFormats.set(this.formats);
        this.formats = newFormats;

        const newData = new Array(newCapacity);
        for (let i = 0; i < this.data.length; i++) newData[i] = this.data[i];
        this.data = newData;

        const newGpuTextures = new Array(newCapacity).fill(null);
        for (let i = 0; i < this.gpuTextures.length; i++) newGpuTextures[i] = this.gpuTextures[i];
        this.gpuTextures = newGpuTextures;

        const newViews = new Array(newCapacity).fill(null);
        for (let i = 0; i < this.views.length; i++) newViews[i] = this.views[i];
        this.views = newViews;

        const newLockedPtrs = new Int32Array(newCapacity).fill(-1);
        newLockedPtrs.set(this.lockedPtrs);
        this.lockedPtrs = newLockedPtrs;

        const newGuestPtrs = new Int32Array(newCapacity).fill(-1);
        newGuestPtrs.set(this.guestPtrs);
        this.guestPtrs = newGuestPtrs;

        const newPitches = new Uint32Array(newCapacity);
        newPitches.set(this.pitches);
        this.pitches = newPitches;

        const newDirtyFlags = new Uint8Array(newCapacity);
        newDirtyFlags.set(this.dirtyFlags);
        this.dirtyFlags = newDirtyFlags;

        const newGenerations = new Uint16Array(newCapacity);
        newGenerations.set(this.generations);
        this.generations = newGenerations;

        const newDataSerials = new Uint32Array(newCapacity);
        newDataSerials.set(this.dataSerials);
        this.dataSerials = newDataSerials;

        const newGuestSerials = new Uint32Array(newCapacity);
        newGuestSerials.set(this.guestSerials);
        this.guestSerials = newGuestSerials;

        const newRtFlags = new Uint8Array(newCapacity);
        newRtFlags.set(this.rtFlags);
        this.rtFlags = newRtFlags;

        const newCubeFlags = new Uint8Array(newCapacity);
        newCubeFlags.set(this.cubeFlags);
        this.cubeFlags = newCubeFlags;

        this.capacity = newCapacity;
    }

    // Debug export: get all textures info
    getAllDebugInfo(): Array<{
        handle: number;
        width: number;
        height: number;
        levels: number;
        format: number;
        isDirty: boolean;
        isLocked: boolean;
        hasGpuTexture: boolean;
    }> {
        const result: Array<{
            handle: number;
            width: number;
            height: number;
            levels: number;
            format: number;
            isDirty: boolean;
            isLocked: boolean;
            hasGpuTexture: boolean;
        }> = [];
        
        for (const [handle, packed] of this.handleToIndex.entries()) {
            const index = packed & 0xFFFF;
            const expectedGen = (packed >> 16) & 0xFFFF;
            if (this.generations[index] !== expectedGen) continue;
            if (this.data[index] === undefined) continue;
            
            result.push({
                handle,
                width: this.widths[index],
                height: this.heights[index],
                levels: this.levels[index],
                format: this.formats[index],
                isDirty: this.dirtyFlags[index] !== 0,
                isLocked: this.lockedPtrs[index] !== -1,
                hasGpuTexture: this.gpuTextures[index] !== null,
            });
        }
        
        return result;
    }
}
