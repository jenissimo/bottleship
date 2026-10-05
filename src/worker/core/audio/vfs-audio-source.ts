/**
 * RandomAccessSource adapter over the guest VFS, for container probes that need a
 * few KB from each end of a multi-megabyte file (see @bottleship/formats/audio).
 */
import type { RandomAccessSource } from "@bottleship/formats/unpack/source";
import { System } from "../system";
import type { VfsFileHandle } from "../../runtime/filesystem/vfs";

const GENERIC_READ = 0x80000000;
const OPEN_EXISTING = 3;
const FILE_BEGIN = 0;

const EMPTY = new Uint8Array(0);

/** Bytes cached at each end by prime() — enough for every container's header and
 *  its last frame/page, which is where all four formats keep their length.
 *  Must cover the WIDEST window a probe can ask for, not the common one: the Ogg
 *  probe falls back to a 128 KB tail scan when the last page is not in its fast
 *  32 KB window, and a fallback that misses this cache degrades to an unavailable
 *  sync range — i.e. a silently unknown duration. 128 KB also exceeds the 65307-byte
 *  maximum legal Ogg page, so the tail always holds a complete final page. */
const PRIME_WINDOW_BYTES = 128 * 1024;

interface Window {
    start: number;
    data: Uint8Array;
}

/**
 * The VFS can only serve some ranges asynchronously (compressed ROM entries,
 * cold OPFS overlay files). readRangeSync must never block the worker, so an
 * unavailable range yields an empty slice — probes read that as "not parseable"
 * and the caller degrades to "duration unknown". prime() pre-fetches the head
 * and tail windows through the async path so a later sync probe sees real bytes.
 */
export class VfsAudioSource implements RandomAccessSource {
    readonly size: number;
    private readonly path: string;
    private windows: Window[] = [];
    private handle: VfsFileHandle | null = null;
    private handleOpened = false;

    constructor(path: string, size: number) {
        this.path = path;
        this.size = Math.max(0, size);
    }

    async prime(): Promise<void> {
        await this.fetchWindow(0, Math.min(PRIME_WINDOW_BYTES, this.size));
        if (this.size > PRIME_WINDOW_BYTES) {
            const tailStart = Math.max(0, this.size - PRIME_WINDOW_BYTES);
            await this.fetchWindow(tailStart, this.size - tailStart);
        }
    }

    readRangeSync(start: number, end: number): Uint8Array {
        const from = Math.max(0, Math.min(start, this.size));
        const to = Math.max(from, Math.min(end, this.size));
        if (to === from) return EMPTY;

        const cached = this.fromWindows(from, to);
        if (cached) return cached;

        const handle = this.ensureHandle();
        if (!handle) return EMPTY;

        const vfs = System.getInstance().fileSystem;
        const want = to - from;
        const out = new Uint8Array(want);
        let filled = 0;
        vfs.setPosition(handle, from, FILE_BEGIN);
        while (filled < want) {
            const chunk = vfs.readSync(handle, want - filled);
            if (!chunk || chunk.length === 0) break;
            out.set(chunk, filled);
            filled += chunk.length;
        }
        if (filled === 0) return EMPTY;

        const data = filled === want ? out : out.subarray(0, filled);
        this.addWindow(from, data);
        return data;
    }

    private ensureHandle(): VfsFileHandle | null {
        if (!this.handleOpened) {
            this.handleOpened = true;
            this.handle = System.getInstance().fileSystem.openSync(this.path, GENERIC_READ, OPEN_EXISTING);
        }
        return this.handle;
    }

    private fromWindows(from: number, to: number): Uint8Array | null {
        for (const w of this.windows) {
            if (from >= w.start && to <= w.start + w.data.length) {
                return w.data.subarray(from - w.start, to - w.start);
            }
        }
        return null;
    }

    private addWindow(start: number, data: Uint8Array): void {
        if (data.length === 0) return;
        this.windows.push({ start, data });
        // Two primed windows plus a couple of probe reads is the working set; drop
        // the oldest beyond that so a probe of a large file cannot accrete the file.
        if (this.windows.length > 4) this.windows.shift();
    }

    private async fetchWindow(start: number, length: number): Promise<void> {
        if (length <= 0) return;
        if (this.fromWindows(start, start + length)) return;
        try {
            const vfs = System.getInstance().fileSystem;
            const handle = await vfs.open(this.path, GENERIC_READ, OPEN_EXISTING);
            if (!handle) return;
            vfs.setPosition(handle, start, FILE_BEGIN);
            const data = await vfs.read(handle, length);
            if (data && data.length > 0) this.addWindow(start, data.slice());
        } catch {
            // Unreadable window — the probe degrades to "duration unknown".
        }
    }
}
