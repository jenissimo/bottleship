/**
 * ResourceTable with generation counters to prevent use-after-free.
 * Packed handle format: (generation << 16) | index
 * - Upper 16 bits: generation counter (0-65535)
 * - Lower 16 bits: index into items array
 */
export class ResourceTable<T> {
    private items: (T | undefined)[] = [];
    private freeList: number[] = [];
    private handleToIndex: Map<number, number> = new Map(); // COM handle -> packed (gen|index)
    private generations: Uint16Array;
    private capacity: number;

    constructor(initialCapacity = 256) {
        this.capacity = initialCapacity;
        this.generations = new Uint16Array(initialCapacity);
    }

    create(handle: number, item: T): number {
        let index: number;
        if (this.freeList.length > 0) {
            index = this.freeList.pop()!;
        } else {
            index = this.items.length;
            if (index >= this.capacity) {
                this.grow();
            }
        }
        this.items[index] = item;
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
        const currentGen = this.generations[index];
        if (currentGen !== expectedGen) {
            // Stale handle - generation mismatch
            this.handleToIndex.delete(handle);
            return null;
        }
        return index;
    }

    getByIndex(index: number): T | null {
        return this.items[index] ?? null;
    }

    getByHandle(handle: number): T | null {
        const index = this.getIndex(handle);
        return index === null ? null : this.getByIndex(index);
    }

    /**
     * Release a resource and increment its generation counter.
     * Returns the released item for cleanup, or null if not found.
     */
    release(handle: number): T | null {
        const packed = this.handleToIndex.get(handle);
        if (packed === undefined) return null;
        const index = packed & 0xFFFF;
        const expectedGen = (packed >> 16) & 0xFFFF;
        const currentGen = this.generations[index];
        if (currentGen !== expectedGen) {
            // Already released (stale handle)
            this.handleToIndex.delete(handle);
            return null;
        }
        const item = this.items[index];
        this.items[index] = undefined;
        // Increment generation to invalidate any stale handles
        this.generations[index] = (currentGen + 1) & 0xFFFF;
        this.freeList.push(index);
        this.handleToIndex.delete(handle);
        return item ?? null;
    }

    /**
     * Check if a handle is valid without retrieving the item.
     */
    isValid(handle: number): boolean {
        return this.getIndex(handle) !== null;
    }

    /**
     * Get all active items in the table.
     */
    getAllItems(): T[] {
        return this.items.filter((item): item is T => item !== undefined);
    }

    entries(): Array<[number, T]> {
        const out: Array<[number, T]> = [];
        for (const handle of this.handleToIndex.keys()) {
            const item = this.getByHandle(handle);
            if (item !== null) out.push([handle, item]);
        }
        return out.sort((a, b) => a[0] - b[0]);
    }

    clear(): void {
        this.items = [];
        this.freeList = [];
        this.handleToIndex.clear();
        this.generations = new Uint16Array(this.capacity);
    }

    private grow(): void {
        const newCapacity = this.capacity * 2;
        const newGenerations = new Uint16Array(newCapacity);
        newGenerations.set(this.generations);
        this.generations = newGenerations;
        this.capacity = newCapacity;
    }
}
