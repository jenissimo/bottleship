/** Random-access byte source for Inno parsing (environment-agnostic). */

export interface RandomAccessSource {
    readonly size: number;
    readRangeSync(start: number, end: number): Uint8Array;
}

/** In-memory source — mirrors @bottleship/formats/zip BufferSource. */
export class BufferSource implements RandomAccessSource {
    readonly size: number;

    constructor(private readonly data: Uint8Array) {
        this.size = data.byteLength;
    }

    readRangeSync(start: number, end: number): Uint8Array {
        const clampedStart = Math.max(0, Math.min(start, this.size));
        const clampedEnd = Math.max(clampedStart, Math.min(end, this.size));
        return this.data.subarray(clampedStart, clampedEnd);
    }
}

/**
 * A sub-range of a larger buffer addressed from zero — an image embedded at some
 * offset in a bigger one (a WAV sitting in guest memory, a resource inside a PE)
 * without copying it out first.
 */
export class WindowSource implements RandomAccessSource {
    readonly size: number;

    constructor(
        private readonly data: Uint8Array,
        private readonly base: number,
        length: number,
    ) {
        const start = Math.max(0, Math.min(base, data.length));
        this.base = start;
        this.size = Math.max(0, Math.min(length, data.length - start));
    }

    readRangeSync(start: number, end: number): Uint8Array {
        const from = Math.max(0, Math.min(start, this.size));
        const to = Math.max(from, Math.min(end, this.size));
        return this.data.subarray(this.base + from, this.base + to);
    }
}
