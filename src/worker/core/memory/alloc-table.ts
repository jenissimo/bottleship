/**
 * Guest-allocation bookkeeping keyed by base address: the block's size and the bucket it came
 * from. Every guest HeapAlloc/HeapFree/HeapReAlloc lands here, thousands of times a second, and
 * a JS Map churned at that rate rebuilds its hash table as it grows and shrinks — old-generation
 * garbage that paces the worker's full GCs, and a full GC stalls every guest thread at once.
 * Open addressing over typed arrays with backward-shift deletion allocates only on growth.
 *
 * The two facts are independent, as the Maps they replace were: an alias records a size with
 * no bucket, and a slot exists while either is present.
 */
export class AllocTable<B> {
    private keys: Uint32Array;
    private sizes: Float64Array;
    /** 0 = no bucket; otherwise index+1 into `bucketValues`. */
    private buckets: Uint8Array;
    private hasSize: Uint8Array;
    private used: Uint8Array;
    /** When the size was first recorded — the insertion order the Map it replaces iterated in. */
    private seqs: Float64Array;
    private nextSeq = 0;
    private mask: number;
    private occupied = 0;
    private sizeCount = 0;
    private readonly bucketValues: B[] = [];

    constructor(initialCapacity = 1024) {
        let cap = 16;
        while (cap < initialCapacity * 2) cap <<= 1;
        this.keys = new Uint32Array(cap);
        this.sizes = new Float64Array(cap);
        this.buckets = new Uint8Array(cap);
        this.hasSize = new Uint8Array(cap);
        this.used = new Uint8Array(cap);
        this.seqs = new Float64Array(cap);
        this.mask = cap - 1;
    }

    /** Number of addresses carrying a size — what `allocations.size` meant. */
    get size(): number { return this.sizeCount; }

    has(addr: number): boolean {
        const i = this.find(addr >>> 0);
        return i >= 0 && this.hasSize[i] === 1;
    }

    getSize(addr: number): number | undefined {
        const i = this.find(addr >>> 0);
        return i >= 0 && this.hasSize[i] === 1 ? this.sizes[i] : undefined;
    }

    setSize(addr: number, size: number): void {
        const i = this.slotFor(addr >>> 0);
        if (this.hasSize[i] === 0) { this.hasSize[i] = 1; this.sizeCount++; this.seqs[i] = this.nextSeq++; }
        this.sizes[i] = size;
    }

    deleteSize(addr: number): void {
        const i = this.find(addr >>> 0);
        if (i < 0 || this.hasSize[i] === 0) return;
        this.hasSize[i] = 0;
        this.sizeCount--;
        if (this.buckets[i] === 0) this.remove(i);
    }

    getBucket(addr: number): B | undefined {
        const i = this.find(addr >>> 0);
        if (i < 0 || this.buckets[i] === 0) return undefined;
        return this.bucketValues[this.buckets[i] - 1];
    }

    setBucket(addr: number, bucket: B): void {
        let code = this.bucketValues.indexOf(bucket);
        if (code < 0) {
            if (this.bucketValues.length >= 255) throw new Error("AllocTable: more than 255 bucket kinds");
            code = this.bucketValues.push(bucket) - 1;
        }
        // slotFor may grow and replace the arrays: resolve the slot before indexing.
        const i = this.slotFor(addr >>> 0);
        this.buckets[i] = code + 1;
    }

    deleteBucket(addr: number): void {
        const i = this.find(addr >>> 0);
        if (i < 0 || this.buckets[i] === 0) return;
        this.buckets[i] = 0;
        if (this.hasSize[i] === 0) this.remove(i);
    }

    /** Every address carrying a size, in the order the sizes were first recorded. Diagnostic
     *  and HeapWalk use only — it allocates. */
    entriesByInsertion(): Array<{ addr: number; size: number; bucket: B | undefined }> {
        const rows: Array<{ addr: number; size: number; bucket: B | undefined; seq: number }> = [];
        for (let i = 0; i < this.keys.length; i++) {
            if (this.used[i] === 0 || this.hasSize[i] === 0) continue;
            rows.push({
                addr: this.keys[i], size: this.sizes[i], seq: this.seqs[i],
                bucket: this.buckets[i] === 0 ? undefined : this.bucketValues[this.buckets[i] - 1],
            });
        }
        rows.sort((a, b) => a.seq - b.seq);
        return rows.map(({ addr, size, bucket }) => ({ addr, size, bucket }));
    }

    clear(): void {
        this.used.fill(0);
        this.hasSize.fill(0);
        this.buckets.fill(0);
        this.occupied = 0;
        this.sizeCount = 0;
    }

    private hash(key: number): number {
        // Allocation bases are 8/16-byte aligned: mix the low bits in before masking.
        return Math.imul(key ^ (key >>> 16), 0x45d9f3b) >>> 0;
    }

    private find(key: number): number {
        let i = this.hash(key) & this.mask;
        while (this.used[i] === 1) {
            if (this.keys[i] === key) return i;
            i = (i + 1) & this.mask;
        }
        return -1;
    }

    private slotFor(key: number): number {
        const found = this.find(key);
        if (found >= 0) return found;
        if ((this.occupied + 1) * 2 > this.keys.length) this.grow();
        let i = this.hash(key) & this.mask;
        while (this.used[i] === 1) i = (i + 1) & this.mask;
        this.used[i] = 1;
        this.keys[i] = key;
        this.hasSize[i] = 0;
        this.buckets[i] = 0;
        this.sizes[i] = 0;
        this.occupied++;
        return i;
    }

    /** Linear-probing delete by backward shift: no tombstones, so probes never lengthen. */
    private remove(slot: number): void {
        const mask = this.mask;
        let i = slot;
        let j = slot;
        for (;;) {
            j = (j + 1) & mask;
            if (this.used[j] === 0) break;
            const home = this.hash(this.keys[j]) & mask;
            // Move j back into the hole at i unless its home lies cyclically in (i, j].
            const inRange = i <= j ? (home > i && home <= j) : (home > i || home <= j);
            if (inRange) continue;
            this.keys[i] = this.keys[j];
            this.sizes[i] = this.sizes[j];
            this.buckets[i] = this.buckets[j];
            this.hasSize[i] = this.hasSize[j];
            this.seqs[i] = this.seqs[j];
            i = j;
        }
        this.used[i] = 0;
        this.hasSize[i] = 0;
        this.buckets[i] = 0;
        this.occupied--;
    }

    private grow(): void {
        const oldKeys = this.keys, oldSizes = this.sizes, oldBuckets = this.buckets;
        const oldHas = this.hasSize, oldUsed = this.used, oldSeqs = this.seqs;
        const cap = oldKeys.length * 2;
        this.keys = new Uint32Array(cap);
        this.sizes = new Float64Array(cap);
        this.buckets = new Uint8Array(cap);
        this.hasSize = new Uint8Array(cap);
        this.used = new Uint8Array(cap);
        this.seqs = new Float64Array(cap);
        this.mask = cap - 1;
        this.occupied = 0;
        for (let s = 0; s < oldKeys.length; s++) {
            if (oldUsed[s] === 0) continue;
            let i = this.hash(oldKeys[s]) & this.mask;
            while (this.used[i] === 1) i = (i + 1) & this.mask;
            this.used[i] = 1;
            this.keys[i] = oldKeys[s];
            this.sizes[i] = oldSizes[s];
            this.buckets[i] = oldBuckets[s];
            this.hasSize[i] = oldHas[s];
            this.seqs[i] = oldSeqs[s];
            this.occupied++;
        }
    }
}
