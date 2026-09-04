/** A cache key may be a packed number where the identity fits one exactly — a
 *  per-draw string join is an allocation the lookup does not need. */
export type PipelineCacheKey = string | number;

export class PipelineCache<T> {
    private readonly map = new Map<PipelineCacheKey, T>();
    private hitsCount = 0;
    private missesCount = 0;

    get(key: PipelineCacheKey): T | undefined {
        const value = this.map.get(key);
        if (value !== undefined) {
            this.hitsCount++;
        } else {
            this.missesCount++;
        }
        return value;
    }

    set(key: PipelineCacheKey, value: T): void {
        this.map.set(key, value);
    }

    clear(): void {
        this.map.clear();
        this.hitsCount = 0;
        this.missesCount = 0;
    }

    size(): number {
        return this.map.size;
    }

    getStats(): { hits: number; misses: number; size: number } {
        return {
            hits: this.hitsCount,
            misses: this.missesCount,
            size: this.map.size,
        };
    }
}
