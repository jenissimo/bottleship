/**
 * System Resource Provider - унифицированная система управления ресурсами
 *
 * Заменяет HandleTable, предоставляет:
 * - Типизированные таблицы ресурсов
 * - Generation counters для защиты от use-after-free
 * - Специализированное управление COM-объектами
 * - Единый AddRef/Release механизм
 */

import { ResourceTable } from '../resource-table';
import { BaseComObject } from '../com/base-com-object';
import { Logger, LogCategory } from '../logger';
// Import from core directly: routing this through ddraw/constants would re-enter the
// constants module while COM memory is initializing.
import { checkComGuard, freeComObject } from '../com/com-memory';
import { System } from '../system';

export enum ResourceType {
    COM_OBJECT = 'com_object',
    GDI_OBJECT = 'gdi_object',
    KERNEL_OBJECT = 'kernel_object',
    USER_OBJECT = 'user_object',
    FILE_HANDLE = 'file_handle',
}

export interface ResourceHandle {
    type: ResourceType;
    id: number; // Handle value returned to WinAPI
    generation: number;
}

/**
 * System Resource Provider - центральный менеджер всех системных ресурсов
 */
export class SystemResourceProvider {
    private static instance: SystemResourceProvider;

    // Типизированные таблицы ресурсов
    private comObjects: ResourceTable<BaseComObject> = new ResourceTable();
    private gdiObjects: ResourceTable<any> = new ResourceTable();
    private kernelObjects: ResourceTable<any> = new ResourceTable();
    private userObjects: ResourceTable<any> = new ResourceTable();
    private fileHandles: ResourceTable<any> = new ResourceTable();

    // Mapping from emulator memory address to handle
    private addressToHandle: Map<number, number> = new Map();
    private handleToAddress: Map<number, number> = new Map();
    // The FIRST address a handle was mapped at — the object's own identity. handleToAddress
    // holds the LAST one, and QueryInterface tear-offs remap the same handle onto a fresh
    // guest block, so anything that means "this object's own interface pointer" (per-interface
    // refcounting) must read this instead.
    private handleToPrimaryAddress: Map<number, number> = new Map();

    // OPTIMIZATION: Index for fast lookup of surfaces by surfacePtr
    // Maps surfacePtr -> Set of COM object handles that share this surfacePtr
    // This avoids O(N) iteration over all COM objects in ReleaseDC and other hot paths
    private surfacePtrIndex: Map<number, Set<number>> = new Map();
    // Reverse mapping for O(1) cleanup: handle -> surfacePtr
    private handleToSurfacePtr: Map<number, number> = new Map();

    // Handle allocation — typed ranges to catch cross-type handle misuse in debug mode.
    // COM is generation-tagged (see comSlotGeneration below): the slot lives in the COM
    // range but the returned handle also carries a generation in bits >=19, so tagged COM
    // handles span {gen0: 0x01000-0x2FFFF} ∪ {gen>=1: 0x80000-0x3BFFFF} and are resolved by
    // map membership, not range. The other classes remain plain monotonic ranges.
    // | Type   | Range            | Mask       |
    // |--------|------------------|------------|
    // | COM    | 0x01000-0x2FFFF  | 0x0-2xxxx  | (slot; +generation in bits >=19)
    // | KERNEL | 0x30000-0x3FFFF  | 0x3xxxx    |
    // | USER   | 0x40000-0x4FFFF  | 0x4xxxx    |
    // | FILE   | 0x50000-0x5FFFF  | 0x5xxxx    |
    // | GDI    | 0x60000-0x6FFFF  | 0x6xxxx    |
    private nextComHandle    = 0x01000;
    private nextGdiHandle    = 0x60000;
    private nextKernelHandle = 0x30000;
    private nextUserHandle   = 0x40000;
    private nextFileHandle   = 0x50000;

    // Free lists for handle recycling.
    // Holds RAW slot values (not the generation-tagged handle). FIFO (push/shift) so reuse
    // is spread across all freed slots → a single slot's generation wraps slowly.
    private freeComHandles: number[] = [];
    /** Freed USER handle SLOTS (generation stripped), reused FIFO (see registerUserObject). */
    private freeUserHandles: number[] = [];
    /** Closed FILE handle slots, reused FIFO like the Win32 process handle table. */
    private freeFileHandles: number[] = [];

    // Generation tagging for COM handles. COM is the only recycled handle class, and a guest
    // that caches a D3DTEXTUREHANDLE across a destroy+recreate (UE1 level load) would otherwise
    // have its stale handle silently resolve to whatever NEW object took the recycled slot —
    // the "cursor texture on a UI element" / TR2 boot-texture-fragment bug class. We bump a
    // per-slot generation on every reuse and fold it into the handle value, so the recycled
    // handle differs from the stale one and the stale handle resolves to null (no object).
    //   tagged = slot | (gen << COM_GEN_SHIFT)
    // Constraints baked into the bit layout:
    //   - gen>=1 lands at >= 0x80000, DISJOINT from kernel/user/file/gdi (0x30000-0x6FFFF);
    //     gen==0 stays in the legacy COM range 0x01000-0x2FFFF (identical to old behavior).
    //   - tagged stays < 0x400000, BELOW the HEAP where COM-object structs live, so a tagged
    //     handle can never collide with a real COM-object ADDRESS in the address-or-handle
    //     dual resolution (resolve()/getComObjectByAddress try address lookup first).
    // 3 bits (8 generations) is what the cramped <0x400000 safe zone allows; combined with
    // FIFO recycling that is ample to defeat practical immediate-reuse aliasing.
    private static readonly COM_GEN_SHIFT = 19;
    private static readonly COM_GEN_MASK  = 0x7;
    /** Raw COM handle slot (generation stripped). Used by ddraw texture-registry slot recycle. */
    static readonly COM_SLOT_MASK = 0x7FFFF;
    private comSlotGeneration: Map<number, number> = new Map(); // raw slot -> current generation

    // Generation tagging for USER handles — same hazard, same answer as COM: the slot comes
    // back on DeleteObject/DestroyIcon/DestroyWindow, and a guest holding the stale HBITMAP
    // would otherwise operate on whatever unrelated object took the slot. The generation
    // lives in bits 0..1 (slots step by 4, so those bits are free), which keeps the tagged
    // handle inside 0x40000-0x4FFFF and therefore inside getResource's USER range.
    private static readonly USER_GEN_MASK = 0x3;
    private userSlotGeneration: Map<number, number> = new Map(); // raw slot -> current generation

    static getInstance(): SystemResourceProvider {
        if (!SystemResourceProvider.instance) {
            SystemResourceProvider.instance = new SystemResourceProvider();
        }
        return SystemResourceProvider.instance;
    }

    /**
     * Register a COM object and return its handle
     */
    registerComObject(obj: BaseComObject): number {
        let slot: number;
        if (this.freeComHandles.length > 0) {
            slot = this.freeComHandles.shift()!; // FIFO — see freeComHandles comment
        } else {
            slot = this.nextComHandle;
            if (slot >= 0x30000) {
                Logger.error(LogCategory.RESOURCE, `COM handle slot range exhausted! slot=0x${slot.toString(16)}`);
            }
            this.nextComHandle += 4;
        }

        // Bump the slot's generation on every (re)allocation so a recycled slot yields a
        // different tagged handle than any stale handle the guest may still hold.
        const gen = (((this.comSlotGeneration.get(slot) ?? -1) + 1) & SystemResourceProvider.COM_GEN_MASK) >>> 0;
        this.comSlotGeneration.set(slot, gen);
        const handle = ((slot | (gen << SystemResourceProvider.COM_GEN_SHIFT)) >>> 0);

        this.comObjects.create(handle, obj);

        Logger.verbose(LogCategory.RESOURCE, `Registered COM object ${obj.constructor.name} handle=0x${handle.toString(16)} (slot=0x${slot.toString(16)} gen=${gen})`);
        return handle;
    }

    /**
     * Map a memory address to a COM handle
     */
    mapAddressToHandle(address: number, handle: number): void {
        Logger.log(LogCategory.RESOURCE, `mapAddressToHandle: 0x${address.toString(16)} -> handle=0x${handle.toString(16)}`);
        this.addressToHandle.set(address, handle);
        this.handleToAddress.set(handle, address);
        if (!this.handleToPrimaryAddress.has(handle)) this.handleToPrimaryAddress.set(handle, address);
    }

    /**
     * Get a COM object by its memory address
     */
    getComObjectByAddress(address: number): BaseComObject | null {
        const handle = this.addressToHandle.get(address);
        if (handle === undefined) return null;

        // Check guard bytes if memory is available
        const system = System.getInstance();
        const mem8 = system.process?.getCurrentMemory();
        if (mem8 && !checkComGuard(mem8, address)) {
            Logger.error(LogCategory.RESOURCE, `COM object at 0x${address.toString(16)} has corrupted guard bytes! Memory corruption detected.`);
            // Don't return null yet, let it continue but log the error
        }

        return this.getComObject(handle);
    }

    /**
     * FAST PATH: Get a COM object by address without guard byte checks.
     * Use only in hot-path fast implementations where corruption detection is non-critical.
     */
    getComObjectByAddressFast(address: number): BaseComObject | null {
        const handle = this.addressToHandle.get(address);
        if (handle === undefined) return null;
        return this.comObjects.getByHandle(handle);
    }

    /**
     * Get a COM object address by handle
     */
    getAddressForHandle(handle: number): number | null {
        return this.handleToAddress.get(handle) ?? null;
    }

    /**
     * The address the object was FIRST published at — its own interface pointer, stable for
     * the object's whole life. Use this (not getAddressForHandle) wherever "the pointer this
     * object was created as" is meant: a tear-off remaps the handle and would otherwise
     * silently become the answer.
     */
    getPrimaryAddressForHandle(handle: number): number | null {
        return this.handleToPrimaryAddress.get(handle) ?? null;
    }

    /**
     * Get a COM object by handle
     */
    getComObject(handle: number): BaseComObject | null {
        return this.comObjects.getByHandle(handle);
    }

    /**
     * Get all active COM objects
     */
    getAllComObjects(): BaseComObject[] {
        return this.comObjects.getAllItems();
    }

    /**
     * OPTIMIZATION: Register a surface's surfacePtr for fast lookup
     * Called when a DirectDrawSurface is created or its surfacePtr is set
     */
    registerSurfacePtr(handle: number, surfacePtr: number): void {
        if (surfacePtr <= 0) return;

        let handles = this.surfacePtrIndex.get(surfacePtr);
        if (!handles) {
            handles = new Set();
            this.surfacePtrIndex.set(surfacePtr, handles);
        }
        handles.add(handle);

        // Store reverse mapping for O(1) cleanup in unregisterComObject
        this.handleToSurfacePtr.set(handle, surfacePtr);
    }

    /**
     * OPTIMIZATION: Unregister a surface's surfacePtr
     * Called when a DirectDrawSurface is destroyed
     */
    unregisterSurfacePtr(handle: number, surfacePtr: number): void {
        if (surfacePtr <= 0) return;

        const handles = this.surfacePtrIndex.get(surfacePtr);
        if (handles) {
            handles.delete(handle);
            if (handles.size === 0) {
                this.surfacePtrIndex.delete(surfacePtr);
            }
        }
    }

    /**
     * OPTIMIZATION: Get all COM objects that share the given surfacePtr
     * Returns empty array if no objects found (O(1) lookup instead of O(N))
     */
    getComObjectsBySurfacePtr(surfacePtr: number): BaseComObject[] {
        if (surfacePtr <= 0) return [];

        const handles = this.surfacePtrIndex.get(surfacePtr);
        if (!handles || handles.size === 0) return [];

        const result: BaseComObject[] = [];
        for (const handle of handles) {
            const obj = this.comObjects.getByHandle(handle);
            if (obj) result.push(obj);
        }
        return result;
    }

    /**
     * Unregister a COM object (called when refcount reaches 0)
     */
    unregisterComObject(handle: number): BaseComObject | null {
        const obj = this.comObjects.release(handle);
        if (obj) {
            // Drop ALL address mappings for this handle (QueryInterface tear-offs and
            // sub-objects map extra guest blocks to the same handle) and return each
            // backing block to the system-object pool — real COM frees the object
            // memory on final Release.
            const memory = System.getInstance().process?.memory;
            for (const [addr, h] of this.addressToHandle.entries()) {
                if (h === handle) {
                    this.addressToHandle.delete(addr);
                    if (memory) freeComObject(memory, addr);
                }
            }
            this.handleToAddress.delete(handle);
            this.handleToPrimaryAddress.delete(handle);

            // OPTIMIZATION: Cleanup surfacePtr index (O(1) using reverse mapping)
            const surfacePtr = this.handleToSurfacePtr.get(handle);
            if (surfacePtr !== undefined) {
                this.unregisterSurfacePtr(handle, surfacePtr);
                this.handleToSurfacePtr.delete(handle);
            }

            // Recycle the RAW slot for reuse (FIFO). The generation is bumped on the next
            // reuse in registerComObject, so the recycled handle differs from this one.
            const slot = (handle & SystemResourceProvider.COM_SLOT_MASK) >>> 0;
            this.freeComHandles.push(slot);

            Logger.verbose(LogCategory.RESOURCE, `Unregistered COM object ${obj.constructor.name} handle=0x${handle.toString(16)} (slot=0x${slot.toString(16)})`);
        }
        return obj;
    }

    /**
     * Register a GDI object
     */
    registerGdiObject(obj: any): number {
        const handle = this.nextGdiHandle;
        if (handle >= 0x70000) {
            Logger.error(LogCategory.RESOURCE, `GDI handle range exhausted! handle=0x${handle.toString(16)}`);
        }
        this.gdiObjects.create(handle, obj);
        this.nextGdiHandle += 4;

        Logger.verbose(LogCategory.RESOURCE, `Registered GDI object handle=0x${handle.toString(16)}`);
        return handle;
    }

    /**
     * Get a GDI object by handle
     */
    getGdiObject(handle: number): any {
        return this.gdiObjects.getByHandle(handle);
    }

    /**
     * Unregister a GDI object
     */
    unregisterGdiObject(handle: number): any {
        return this.gdiObjects.release(handle);
    }

    /**
     * Register a kernel object (file handles, etc.)
     */
    registerKernelObject(obj: any): number {
        const handle = this.nextKernelHandle;
        if (handle >= 0x40000) {
            Logger.error(LogCategory.RESOURCE, `Kernel handle range exhausted! handle=0x${handle.toString(16)}`);
        }
        this.kernelObjects.create(handle, obj);
        this.nextKernelHandle += 4;

        Logger.verbose(LogCategory.RESOURCE, `Registered kernel object handle=0x${handle.toString(16)}`);
        return handle;
    }

    /**
     * Get a kernel object by handle
     */
    getKernelObject(handle: number): any {
        return this.kernelObjects.getByHandle(handle);
    }

    /**
     * Unregister a kernel object
     */
    unregisterKernelObject(handle: number): any {
        return this.kernelObjects.release(handle);
    }

    /**
     * Register a user object (windows, bitmaps, icons, cursors).
     *
     * Handles are RECYCLED. The user range holds 16384 handles; a launcher that rebuilds its
     * buttons from a compatible bitmap per repaint burns six of them a frame, so a monotonic
     * allocator runs off the end of the range within a couple of minutes — and the handles it
     * then hands out fall inside the FILE and GDI ranges, where getResource() dispatches them
     * to the wrong table. Windows survives that workload because its handle slots come back on
     * DeleteObject/DestroyIcon, not because its space is unbounded.
     *
     * Recycling ALIASES, so the slot is generation-tagged (see USER_GEN_MASK): a stale
     * HBITMAP resolves to null instead of silently naming whatever icon/cursor/window took
     * the slot next.
     */
    registerUserObject(obj: any): number {
        let slot: number;
        if (this.freeUserHandles.length > 0) {
            slot = this.freeUserHandles.shift()!; // FIFO — delay reuse of any one slot
        } else {
            slot = this.nextUserHandle;
            if (slot >= 0x50000) {
                Logger.error(LogCategory.RESOURCE, `User handle range exhausted! handle=0x${slot.toString(16)}`);
            }
            this.nextUserHandle += 4;
        }
        const gen = (((this.userSlotGeneration.get(slot) ?? -1) + 1) & SystemResourceProvider.USER_GEN_MASK) >>> 0;
        this.userSlotGeneration.set(slot, gen);
        const handle = (slot | gen) >>> 0;
        this.userObjects.create(handle, obj);

        Logger.log(LogCategory.RESOURCE, `Registered user object handle=0x${handle.toString(16)} type=${obj?.type || '?'}`);
        return handle;
    }

    /**
     * Get a user object by handle
     */
    getUserObject(handle: number): any {
        return this.userObjects.getByHandle(handle);
    }

    /**
     * Unregister a user object and return its slot to the free list.
     */
    unregisterUserObject(handle: number): any {
        const obj = this.userObjects.release(handle);
        if (obj !== null && obj !== undefined) {
            // Recycle the RAW slot; the generation is bumped on the next reuse, so the
            // recycled handle differs from this one.
            this.freeUserHandles.push((handle & ~SystemResourceProvider.USER_GEN_MASK) >>> 0);
        }
        return obj;
    }

    /**
     * Register a file handle
     */
    registerFileHandle(obj: any): number {
        let handle: number;
        if (this.freeFileHandles.length > 0) {
            handle = this.freeFileHandles.shift()!;
        } else {
            handle = this.nextFileHandle;
            if (handle >= 0x60000) {
                Logger.error(LogCategory.RESOURCE, `File handle range exhausted! handle=0x${handle.toString(16)}`);
            }
            this.nextFileHandle += 4;
        }
        this.fileHandles.create(handle, obj);

        Logger.verbose(LogCategory.RESOURCE, `Registered file handle=0x${handle.toString(16)}`);
        return handle;
    }

    /**
     * Get a file handle object
     */
    getFileHandle(handle: number): any {
        return this.fileHandles.getByHandle(handle);
    }

    /**
     * Unregister a file handle
     */
    unregisterFileHandle(handle: number): any {
        const obj = this.fileHandles.release(handle);
        if (obj !== null && obj !== undefined) {
            this.freeFileHandles.push(handle >>> 0);
        }
        return obj;
    }

    /**
     * Generic resource lookup by handle — uses typed ranges for O(1) dispatch
     */
    getResource(handle: number): { type: ResourceType; resource: any } | null {
        // COM handles are generation-tagged and may exceed the legacy 0x01000-0x2FFFF range
        // (gen>=1 lands at >=0x80000), so resolve them by map membership rather than by range.
        // Their value space is disjoint from the other classes' ranges (0x30000-0x6FFFF), so
        // this cannot shadow a kernel/user/file/gdi handle.
        const comResource = this.comObjects.getByHandle(handle);
        if (comResource) return { type: ResourceType.COM_OBJECT, resource: comResource };

        let resource: any;
        if (handle >= 0x60000 && handle < 0x70000) {
            resource = this.gdiObjects.getByHandle(handle);
            if (resource) return { type: ResourceType.GDI_OBJECT, resource };
        } else if (handle >= 0x30000 && handle < 0x40000) {
            resource = this.kernelObjects.getByHandle(handle);
            if (resource) return { type: ResourceType.KERNEL_OBJECT, resource };
        } else if (handle >= 0x40000 && handle < 0x50000) {
            resource = this.userObjects.getByHandle(handle);
            if (resource) return { type: ResourceType.USER_OBJECT, resource };
        } else if (handle >= 0x50000 && handle < 0x60000) {
            resource = this.fileHandles.getByHandle(handle);
            if (resource) return { type: ResourceType.FILE_HANDLE, resource };
        }
        return null;
    }

    /**
     * Check if a handle is valid
     */
    isValidHandle(handle: number): boolean {
        return this.getResource(handle) !== null;
    }

    /**
     * Get resource statistics
     */
    getStatistics(): Record<ResourceType, { count: number; peak: number }> {
        return {
            [ResourceType.COM_OBJECT]: {
                count: this.comObjects.getStatistics().count,
                peak: this.comObjects.getStatistics().peak
            },
            [ResourceType.GDI_OBJECT]: {
                count: this.gdiObjects.getStatistics().count,
                peak: this.gdiObjects.getStatistics().peak
            },
            [ResourceType.KERNEL_OBJECT]: {
                count: this.kernelObjects.getStatistics().count,
                peak: this.kernelObjects.getStatistics().peak
            },
            [ResourceType.USER_OBJECT]: {
                count: this.userObjects.getStatistics().count,
                peak: this.userObjects.getStatistics().peak
            },
            [ResourceType.FILE_HANDLE]: {
                count: this.fileHandles.getStatistics().count,
                peak: this.fileHandles.getStatistics().peak
            }
        };
    }

    /**
     * Scan for COM objects with suspiciously high refcounts (leak detection).
     * Call periodically (e.g., every few seconds) during gameplay.
     */
    scanForLeaks(threshold: number = 100): void {
        const allCom = this.comObjects.getAllItems();
        for (const obj of allCom) {
            if (obj && typeof obj === 'object' && 'refCount' in obj) {
                const comObj = obj as BaseComObject;
                if (comObj.refCount > threshold) {
                    Logger.warn(LogCategory.RESOURCE,
                        `COM LEAK? ${comObj.constructor.name} handle=0x${comObj.handle.toString(16)} ` +
                        `refCount=${comObj.refCount} (threshold=${threshold})`);
                }
            }
        }
    }

    /**
     * Force-release all COM objects regardless of refcount.
     * Called during shutdown to prevent VRAM and memory leaks.
     */
    forceReleaseAllCom(): void {
        const allCom = this.comObjects.getAllItems();
        let released = 0;
        for (const obj of allCom) {
            if (obj && typeof obj === 'object' && 'forceRelease' in obj) {
                try {
                    (obj as BaseComObject).forceRelease();
                    released++;
                } catch (e) {
                    Logger.warn(LogCategory.RESOURCE, `Error force-releasing COM object: ${e}`);
                }
            }
        }
        if (released > 0) {
            Logger.log(LogCategory.RESOURCE, `Force-released ${released} COM objects during shutdown`);
        }
    }

    /**
     * Cleanup all resources (for shutdown)
     */
    cleanup(): void {
        Logger.log(LogCategory.RESOURCE, 'Cleaning up all resources');

        // Force-release COM objects first (triggers destroy() for GPU resource cleanup)
        this.forceReleaseAllCom();

        // Note: ResourceTable cleanup is handled by the tables themselves
        this.comObjects = new ResourceTable();
        this.gdiObjects = new ResourceTable();
        this.kernelObjects = new ResourceTable();
        this.userObjects = new ResourceTable();
        this.fileHandles = new ResourceTable();

        // Clear address mappings
        this.addressToHandle.clear();
        this.handleToAddress.clear();
        this.handleToPrimaryAddress.clear();

        // Clear surfacePtr index
        this.surfacePtrIndex.clear();
        this.handleToSurfacePtr.clear();

        // Reset typed handle counters and free lists
        this.nextComHandle    = 0x01000;
        this.nextGdiHandle    = 0x60000;
        this.nextKernelHandle = 0x30000;
        this.nextUserHandle   = 0x40000;
        this.nextFileHandle   = 0x50000;
        this.freeComHandles   = [];
        this.freeUserHandles  = [];
        this.freeFileHandles  = [];
        this.comSlotGeneration.clear();
        this.userSlotGeneration.clear();
    }
}

/**
 * Helper extensions for ResourceTable statistics
 */
declare module '../resource-table' {
    interface ResourceTable<T> {
        getStatistics(): { count: number; peak: number };
    }
}

// Add statistics method to ResourceTable.
// `count` is the true live-object count. `peak` is a high-water mark across OBSERVATIONS
// (it can only rise when someone calls this) — it is not a continuously tracked maximum, so
// never read it as "the most handles this table ever held".
(ResourceTable.prototype as any).getStatistics = function () {
    const count = this.getAllItems().length;
    this.__peakObserved = Math.max(this.__peakObserved ?? 0, count);
    return { count, peak: this.__peakObserved };
};
