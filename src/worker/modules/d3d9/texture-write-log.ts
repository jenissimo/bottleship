interface TextureDescription {
    width: number;
    height: number;
    levels: number;
    format: number;
    usage: number;
    pool: number;
}

interface TraceOptions {
    arm?: boolean;
    width?: number;
    height?: number;
    format?: number;
    limit?: number;
}

/** Opt-in CPU transfer evidence: an empty texture and a lost upload look identical on screen. */
class TextureWriteLog {
    enabled = false;
    private options: TraceOptions = {};
    private textures = new Map<number, TextureDescription>();
    private events: Record<string, unknown>[] = [];
    private dropped = 0;

    configure(options?: TraceOptions): Record<string, unknown> {
        if (options?.arm !== undefined) {
            this.enabled = options.arm;
            if (options.arm) {
                this.options = { ...options, limit: Math.max(1, Math.min(4096, options.limit ?? 512)) };
                this.textures.clear();
                this.events = [];
                this.dropped = 0;
            }
        }
        return { enabled: this.enabled, filter: this.options, dropped: this.dropped, events: this.events.slice() };
    }

    create(ptr: number, description: TextureDescription): void {
        if (!this.enabled) return;
        const filter = this.options;
        if ((filter.width !== undefined && description.width !== filter.width)
            || (filter.height !== undefined && description.height !== filter.height)
            || (filter.format !== undefined && description.format !== filter.format)) return;
        if (!this.textures.has(ptr) && this.textures.size === 4096) {
            this.textures.delete(this.textures.keys().next().value!);
        }
        this.textures.set(ptr, description);
        this.record(ptr, 'create', { ...description });
    }

    selected(ptr: number): boolean { return this.enabled && this.textures.has(ptr); }

    record(ptr: number, op: string, details: Record<string, unknown>, bytes?: Uint8Array | null): void {
        if (!this.selected(ptr)) return;
        let pixels: Record<string, unknown> | null = null;
        if (bytes) {
            const nonzero = [0, 0, 0, 0];
            const maximum = [0, 0, 0, 0];
            for (let i = 0; i < bytes.length; i++) {
                const channel = i & 3;
                nonzero[channel] += Number(bytes[i] !== 0);
                maximum[channel] = Math.max(maximum[channel], bytes[i]);
            }
            pixels = { bytes: bytes.length, nonzero, maximum, firstBytes: Array.from(bytes.subarray(0, 32)) };
        }
        if (this.events.length === this.options.limit) { this.events.shift(); this.dropped++; }
        this.events.push({ ptr: `0x${(ptr >>> 0).toString(16)}`, op, ...details, pixels });
    }
}

export const textureWriteLog = new TextureWriteLog();
