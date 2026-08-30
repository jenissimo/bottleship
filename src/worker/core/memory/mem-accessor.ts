import { Logger, LogCategory } from "../logger";
import { reportMemoryFault, MemoryAccessType } from "./memory-fault";
import { borrowGuestMemory } from "./guest-memory";
import type { RegionEntry } from "./address-space";
import { jsWriteTrap } from "./js-write-trap";

export interface WatchRange {
    lo: number;
    hi: number;
    tag: string;
    handle: number;
    isFatal?: boolean;      // If true, logs as ERROR and mentions corruption
    triggerLimit?: number;  // Only log first N matches
    triggerCount?: number;  // Current match count
}

/**
 * Global memory accessor that always returns fresh memory from v86.
 * No caching - eliminates stale buffer issues after async operations.
 */
export class Mem {
    private static memoryGetter: (() => Uint8Array) | null = null;
    private static validateRange: ((address: number, size: number, perms: string) => boolean) | null = null;
    private static getRegion: ((address: number) => RegionEntry | null) | null = null;

    private static watchRanges: WatchRange[] = [];
    private static nextWatchHandle = 1;

    private static logStackWrite(_address: number, _size: number, _value: number | Uint8Array): void {
        // No-op: was used for stack-write ring buffer during GPF investigation.
    }

    /**
     * Bind the memory getter function. Called once during process initialization.
     * The getter should return the current v86 memory view.
     */
    static bind(
        getter: () => Uint8Array,
        validator?: (address: number, size: number, perms: string) => boolean,
        regionGetter?: (address: number) => RegionEntry | null
    ): void {
        this.memoryGetter = getter;
        this.validateRange = validator ?? null;
        this.getRegion = regionGetter ?? null;
    }

    static pushWriteWatchRange(lo: number, hi: number, tag: string, isFatal: boolean = true, limit: number = 0): number {
        const handle = this.nextWatchHandle++;
        this.watchRanges.push({ lo, hi, tag, handle, isFatal, triggerLimit: limit, triggerCount: 0 });
        return handle;
    }

    static popWriteWatchRange(handle: number): void {
        const initialLen = this.watchRanges.length;
        this.watchRanges = this.watchRanges.filter(r => r.handle !== handle);
        // Logging disabled
    }

    static clearWatchRanges(): void {
        Mem.watchRanges = [];
        // Logging disabled
    }

    private static checkWatch(address: number, size: number, value?: number | Uint8Array): void {
        if (this.watchRanges.length === 0) return;

        for (const range of this.watchRanges) {
            const addrEnd = address + size;
            // Check if write overlaps with watched range
            if (address < range.hi && addrEnd > range.lo) {
                // Check threshold
                if (range.triggerLimit !== undefined && range.triggerLimit > 0) {
                    if ((range.triggerCount ?? 0) >= range.triggerLimit) continue;
                    range.triggerCount = (range.triggerCount ?? 0) + 1;
                }

                const valueStr = value !== undefined
                    ? (typeof value === 'number'
                        ? `0x${value.toString(16)}`
                        : `[${(value as Uint8Array).length} bytes]`)
                    : 'unknown';

                if (range.isFatal) {
                    Logger.error(LogCategory.SYSTEM,
                        `🚨 STACK CORRUPTION DETECTED! Write to watched range: ` +
                        `addr=0x${address.toString(16)}, size=${size}, value=${valueStr}. ` +
                        `Watch: ${range.tag} (0x${range.lo.toString(16)}-0x${range.hi.toString(16)})`);
                } else {
                    Logger.log(LogCategory.SYSTEM,
                        `[WATCH][${range.tag}] Write to 0x${address.toString(16)} (size ${size}) val=${valueStr}`);
                }

                // Dump stack trace if fatal
                if (range.isFatal) {
                    try {
                        const stack = new Error().stack;
                        Logger.error(LogCategory.SYSTEM, `Stack trace:\n${stack}`);
                    } catch { }
                }
            }
        }
    }

    /**
     * Get fresh memory. For use by async thunks that may complete after memory was replaced.
     */
    static getView(): Uint8Array | null {
        return this.getMemory();
    }

    /**
     * Get fresh memory. Always returns the current v86 memory view.
     *
     * Unwrapped to a plain Uint8Array via toPlainGuestMemory(): v86's view()
     * returns a Proxy whose per-element get/set traps defeat V8's typed-array
     * JIT fast path (~50x slower — see guest-memory.ts). This is growth-safe
     * because every Mem read/write re-fetches through here (never field-caches
     * the view), and toPlainGuestMemory re-derives the plain view whenever the
     * underlying ArrayBuffer identity changes (WASM memory growth).
     */
    private static getMemory(): Uint8Array | null {
        if (!this.memoryGetter) {
            Logger.error(LogCategory.SYSTEM, "Mem accessor: not bound");
            return null;
        }
        return borrowGuestMemory(this.memoryGetter());
    }

    private static ensure(
        address: number,
        size: number,
        perms: string,
        context: string,
        accessType: MemoryAccessType
    ): Uint8Array | null {
        const mem = this.getMemory();
        if (!mem) return null;

        if (perms.includes("w")) {
            this.checkWatch(address, size);
        }

        // Validate range if validator is available
        if (this.validateRange && !this.validateRange(address, size, perms)) {
            const region = this.getRegion?.(address);
            reportMemoryFault({
                address,
                size,
                perms,
                region,
                accessType,
                context,
                reason: "Mem accessor range check failed",
            });
            return null;
        }

        return mem;
    }

    static readUint32(address: number): number | null {
        const mem = this.ensure(address, 4, "r", "Mem.readUint32", "read");
        if (!mem) return null;
        const a = address;
        return (
            mem[a] |
            (mem[a + 1] << 8) |
            (mem[a + 2] << 16) |
            (mem[a + 3] << 24)
        ) >>> 0;
    }

    static readUint8(address: number): number | null {
        const mem = this.ensure(address, 1, "r", "Mem.readUint8", "read");
        if (!mem) return null;
        return mem[address]!;
    }

    static readBytes(address: number, length: number): Uint8Array | null {
        const mem = this.ensure(address, length, "r", "Mem.readBytes", "read");
        if (!mem) return null;
        return mem.subarray(address, address + length);
    }

    static readInt32(address: number): number | null {
        const mem = this.ensure(address, 4, "r", "Mem.readInt32", "read");
        if (!mem) return null;
        const a = address;
        return (
            mem[a] |
            (mem[a + 1] << 8) |
            (mem[a + 2] << 16) |
            (mem[a + 3] << 24)
        );
    }

    static readUint16(address: number): number | null {
        const mem = this.ensure(address, 2, "r", "Mem.readUint16", "read");
        if (!mem) return null;
        const a = address;
        return mem[a] | (mem[a + 1] << 8);
    }

    static readInt16(address: number): number | null {
        const value = this.readUint16(address);
        if (value === null) return null;
        return value & 0x8000 ? value - 0x10000 : value;
    }

    /**
     * Cached DataView over the CURRENT guest view.
     *
     * Every scalar accessor below builds a DataView per call, which is fine at one
     * read but not at ten per vertex. Keyed on the VIEW, not its ArrayBuffer: the
     * view carries the base this DataView is built at, so two sub-views over one
     * buffer must not share an entry — a buffer-only key would silently displace
     * every read by the difference. Growth replaces the view too, which is what
     * makes holding this across turns legal where holding a Uint8Array is not.
     */
    private static cachedFloatView: DataView | null = null;
    private static cachedFloatMem: Uint8Array | null = null;

    private static floatView(mem: Uint8Array): DataView {
        if (this.cachedFloatMem !== mem || !this.cachedFloatView) {
            this.cachedFloatView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            this.cachedFloatMem = mem;
        }
        return this.cachedFloatView;
    }

    /**
     * Read `count` consecutive little-endian floats into `out`, validating the whole
     * extent once — the boundary-validate-then-hoist shape, at accessor granularity.
     * Returns false (leaving `out` untouched) when the extent is not readable.
     */
    static readFloat32Into(address: number, count: number, out: Float32Array): boolean {
        if (out.length < count) return false;
        const mem = this.ensure(address, count * 4, "r", "Mem.readFloat32Into", "read");
        if (!mem) return false;
        const view = this.floatView(mem);
        for (let i = 0; i < count; i++) {
            out[i] = view.getFloat32(address + i * 4, true);
        }
        return true;
    }

    static readFloat32(address: number): number | null {
        const mem = this.ensure(address, 4, "r", "Mem.readFloat32", "read");
        if (!mem) return null;
        return this.floatView(mem).getFloat32(address, true);
    }

    static readFloat64(address: number): number | null {
        const mem = this.ensure(address, 8, "r", "Mem.readFloat64", "read");
        if (!mem) return null;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        return view.getFloat64(address, true);
    }

    static writeUint32(address: number, value: number): boolean {
        this.logStackWrite(address, 4, value);
        this.checkWatch(address, 4, value);
        jsWriteTrap.note(address, 4, value);
        const mem = this.ensure(address, 4, "w", "Mem.writeUint32", "write");
        if (!mem) return false;
        mem[address] = value & 0xff;
        mem[address + 1] = (value >>> 8) & 0xff;
        mem[address + 2] = (value >>> 16) & 0xff;
        mem[address + 3] = (value >>> 24) & 0xff;
        return true;
    }

    static writeUint16(address: number, value: number): boolean {
        this.logStackWrite(address, 2, value);
        this.checkWatch(address, 2, value);
        jsWriteTrap.note(address, 2, value);
        const mem = this.ensure(address, 2, "w", "Mem.writeUint16", "write");
        if (!mem) return false;
        mem[address] = value & 0xff;
        mem[address + 1] = (value >>> 8) & 0xff;
        return true;
    }

    static writeUint8(address: number, value: number): boolean {
        this.logStackWrite(address, 1, value);
        this.checkWatch(address, 1, value);
        jsWriteTrap.note(address, 1, value);
        const mem = this.ensure(address, 1, "w", "Mem.writeUint8", "write");
        if (!mem) return false;
        mem[address] = value & 0xff;
        return true;
    }

    static writeFloat32(address: number, value: number): boolean {
        this.logStackWrite(address, 4, value);
        this.checkWatch(address, 4, value);
        jsWriteTrap.note(address, 4, value);
        const mem = this.ensure(address, 4, "w", "Mem.writeFloat32", "write");
        if (!mem) return false;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setFloat32(address, value, true);
        return true;
    }

    static writeFloat64(address: number, value: number): boolean {
        this.logStackWrite(address, 8, value);
        this.checkWatch(address, 8, value);
        jsWriteTrap.note(address, 8, value);
        const mem = this.ensure(address, 8, "w", "Mem.writeFloat64", "write");
        if (!mem) return false;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setFloat64(address, value, true);
        return true;
    }

    static writeBytes(address: number, data: Uint8Array): number {
        this.logStackWrite(address, data.length, data);
        this.checkWatch(address, data.length, data);
        jsWriteTrap.note(address, data.length, data);
        const mem = this.ensure(address, data.length, "w", "Mem.writeBytes", "write");
        if (!mem) return 0;
        mem.set(data, address);
        return data.length;
    }

    static memcpy(dest: number, src: number, length: number): boolean {
        const mem = this.ensure(dest, length, "w", "Mem.memcpy", "write");
        if (!mem) return false;
        // Read source bytes
        const source = mem.subarray(src, src + length);
        this.logStackWrite(dest, length, source);
        this.checkWatch(dest, length);
        jsWriteTrap.note(dest, length, source);
        mem.set(source, dest);
        return true;
    }

    /**
     * memmove: overlap-correct copy in ONE native pass, no temporary.
     *
     * `copyWithin` is the platform's memmove — it is defined for overlapping ranges, so the
     * usual "read the source into a fresh Uint8Array, then write it" shape is pure waste: two
     * copies plus a per-call allocation the GC then has to take back. That shape cost ~5.6 µs
     * a call on a title issuing several hundred a frame. Both ranges are validated (source
     * readable, destination writable) so the safety is the same as read+write.
     */
    static memmove(dest: number, src: number, length: number): boolean {
        if (length <= 0) return true;
        if (!this.ensure(src, length, "r", "Mem.memmove", "read")) return false;
        const mem = this.ensure(dest, length, "w", "Mem.memmove", "write");
        if (!mem) return false;
        const source = mem.subarray(src, src + length);
        this.logStackWrite(dest, length, source);
        this.checkWatch(dest, length, source);
        jsWriteTrap.note(dest, length, source);
        mem.copyWithin(dest, src, src + length);
        return true;
    }

    /**
     * @deprecated No longer needed - memory is always fresh
     */
    static sync(): void {
        // No-op for backwards compatibility
    }
}
