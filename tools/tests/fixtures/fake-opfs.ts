/**
 * Minimal in-memory FileSystem Access API fake — OPFS does not exist under `bun test`,
 * and the VFS overlay's whole job is mediating it, so the interesting bugs (short reads,
 * write-buffer drops, read-after-write) are only reachable with a real overlay behind it.
 *
 * Deliberately faithful about the two things the production bugs turn on:
 *   - `FileSystemSyncAccessHandle.read` MAY return fewer bytes than asked for without
 *     being at EOF (`shortReadLimit` forces it), which is exactly what F9 mishandled.
 *   - a WritableFileStream's changes are invisible to readers until close().
 */

export function notFound(): Error {
    const e = new Error("not found");
    (e as unknown as { name: string }).name = "NotFoundError";
    return e;
}

function typeMismatch(): Error {
    const e = new Error("type mismatch");
    (e as unknown as { name: string }).name = "TypeMismatchError";
    return e;
}

export class FakeFile {
    /** Committed bytes — what a reader observes. */
    data = new Uint8Array(0);
    /** When > 0, every sync read returns at most this many bytes per call. */
    shortReadLimit = 0;
    /**
     * When >= 0, reads at or past this offset produce nothing — the access handle stops
     * short of the size the index reports (a partial/failed commit). Looping cannot
     * recover it, which is what makes it the case that distinguishes a short read from
     * an EOF for the ROM-underlay merge.
     */
    readableUntil = -1;
    constructor(public name: string) { }
}

class FakeSyncAccessHandle {
    closed = false;
    constructor(private file: FakeFile) { }
    read(buffer: Uint8Array, opts: { at: number }): number {
        const at = opts.at;
        const limit = this.file.readableUntil >= 0
            ? Math.min(this.file.data.length, this.file.readableUntil)
            : this.file.data.length;
        const available = Math.max(0, limit - at);
        let n = Math.min(buffer.length, available);
        if (this.file.shortReadLimit > 0) n = Math.min(n, this.file.shortReadLimit);
        if (n > 0) buffer.set(this.file.data.subarray(at, at + n), 0);
        return n;
    }
    write(buffer: Uint8Array, opts: { at: number }): number {
        const end = opts.at + buffer.length;
        if (this.file.data.length < end) {
            const grown = new Uint8Array(end);
            grown.set(this.file.data, 0);
            this.file.data = grown;
        }
        this.file.data.set(buffer, opts.at);
        return buffer.length;
    }
    truncate(size: number): void {
        const next = new Uint8Array(size);
        next.set(this.file.data.subarray(0, Math.min(size, this.file.data.length)), 0);
        this.file.data = next;
    }
    getSize(): number { return this.file.data.length; }
    flush(): void { /* already in memory */ }
    close(): void { this.closed = true; }
}

class FakeWritable {
    private staged: Uint8Array;
    private cursor = 0;
    constructor(private file: FakeFile, keepExistingData: boolean) {
        this.staged = keepExistingData ? new Uint8Array(file.data) : new Uint8Array(0);
    }
    async seek(pos: number): Promise<void> { this.cursor = pos; }
    async truncate(size: number): Promise<void> {
        const next = new Uint8Array(size);
        next.set(this.staged.subarray(0, Math.min(size, this.staged.length)), 0);
        this.staged = next;
    }
    async write(chunk: ArrayBuffer | Uint8Array | string): Promise<void> {
        const bytes = typeof chunk === "string"
            ? new TextEncoder().encode(chunk)
            : (chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        const end = this.cursor + bytes.length;
        if (this.staged.length < end) {
            const grown = new Uint8Array(end);
            grown.set(this.staged, 0);
            this.staged = grown;
        }
        this.staged.set(bytes, this.cursor);
        this.cursor = end;
    }
    /** Only on close does a writable stream's content become visible. */
    async close(): Promise<void> { this.file.data = this.staged; }
    async abort(): Promise<void> { /* discard */ }
}

export class FakeFileHandle {
    kind = "file" as const;
    constructor(public name: string, public file: FakeFile) { }
    async getFile() {
        const data = this.file.data;
        return {
            size: data.length,
            arrayBuffer: async () => data.buffer,
            text: async () => new TextDecoder().decode(data),
            slice: (start: number, end: number) => ({
                arrayBuffer: async () => data.slice(start, end).buffer,
            }),
        };
    }
    async createWritable(opts?: { keepExistingData?: boolean }) {
        return new FakeWritable(this.file, opts?.keepExistingData ?? false);
    }
    async createSyncAccessHandle() { return new FakeSyncAccessHandle(this.file); }
}

export class FakeDirHandle {
    kind = "directory" as const;
    children = new Map<string, FakeDirHandle | FakeFileHandle>();
    constructor(public name: string) { }
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
        let c = this.children.get(name);
        if (!c) {
            if (!opts?.create) throw notFound();
            c = new FakeDirHandle(name);
            this.children.set(name, c);
        }
        if (c.kind !== "directory") throw typeMismatch();
        return c as FakeDirHandle;
    }
    async getFileHandle(name: string, opts?: { create?: boolean }) {
        let c = this.children.get(name);
        if (!c) {
            if (!opts?.create) throw notFound();
            c = new FakeFileHandle(name, new FakeFile(name));
            this.children.set(name, c);
        }
        if (c.kind !== "file") throw typeMismatch();
        return c as FakeFileHandle;
    }
    async removeEntry(name: string, _opts?: { recursive?: boolean }) {
        if (!this.children.has(name)) throw notFound();
        this.children.delete(name);
    }
    async *entries() { yield* this.children.entries(); }
}

/** Install the fake as `navigator.storage`; returns the OPFS root. */
export function installFakeOpfs(): FakeDirHandle {
    const root = new FakeDirHandle("");
    (globalThis as unknown as { navigator: unknown }).navigator = {
        storage: { getDirectory: async () => root },
    };
    return root;
}

/**
 * Find a file the overlay created, by basename, anywhere under the fake root — so a test
 * can inspect it or force short reads without hard-coding the container-dir hash.
 */
export function findFakeByName(dir: FakeDirHandle, name: string): FakeFile | null {
    for (const [childName, child] of dir.children) {
        if (child.kind === "file") {
            if (childName === name) return child.file;
        } else {
            const hit = findFakeByName(child, name);
            if (hit) return hit;
        }
    }
    return null;
}
