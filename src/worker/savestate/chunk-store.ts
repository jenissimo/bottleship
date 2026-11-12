export interface ChunkStore {
    has(hash: string): Promise<boolean>;
    get(hash: string): Promise<Uint8Array | null>;
    put(hash: string, bytes: Uint8Array): Promise<void>;
    list(): Promise<string[]>;
    delete(hash: string): Promise<void>;
    size(hash: string): Promise<number>;
    putMany?(items: ReadonlyArray<readonly [hash: string, bytes: Uint8Array]>): Promise<void>;
    deleteMany?(hashes: readonly string[]): Promise<void>;
    sweep?(): Promise<unknown>;
}

const HASH_NAME = /^[0-9a-f]{64}$/;

export function isChunkHash(hash: unknown): hash is string {
    return typeof hash === 'string' && HASH_NAME.test(hash);
}

function checkHash(hash: string): string {
    if (!isChunkHash(hash)) throw new Error(`savestate: ${JSON.stringify(hash)} is not a chunk hash`);
    return hash;
}

export class MemoryChunkStore implements ChunkStore {
    readonly chunks = new Map<string, Uint8Array>();
    async has(hash: string): Promise<boolean> { return this.chunks.has(checkHash(hash)); }
    async get(hash: string): Promise<Uint8Array | null> { return this.chunks.get(checkHash(hash))?.slice() ?? null; }
    async put(hash: string, bytes: Uint8Array): Promise<void> { this.chunks.set(checkHash(hash), bytes.slice()); }
    async list(): Promise<string[]> { return [...this.chunks.keys()]; }
    async delete(hash: string): Promise<void> { this.chunks.delete(checkHash(hash)); }
    async size(hash: string): Promise<number> { return this.chunks.get(checkHash(hash))?.length ?? 0; }
}

export interface PackDir {
    names(): Promise<string[]>;
    read(name: string, from?: number, to?: number): Promise<Uint8Array | null>;
    write(name: string, bytes: Uint8Array): Promise<void>;
    remove(name: string): Promise<void>;
}

export class MemoryPackDir implements PackDir {
    readonly files = new Map<string, Uint8Array>();
    writes = 0;
    reads = 0;
    async names(): Promise<string[]> { return [...this.files.keys()]; }
    async read(name: string, from = 0, to?: number): Promise<Uint8Array | null> {
        this.reads++;
        return this.files.get(name)?.slice(from, to) ?? null;
    }
    async write(name: string, bytes: Uint8Array): Promise<void> { this.writes++; this.files.set(name, bytes.slice()); }
    async remove(name: string): Promise<void> { this.files.delete(name); }
}

export class OpfsPackDir implements PackDir {
    private readonly open = new Map<string, File>();
    private constructor(private readonly dir: FileSystemDirectoryHandle) {}

    static async open(path: readonly string[], root?: FileSystemDirectoryHandle): Promise<OpfsPackDir> {
        let dir = root ?? await navigator.storage.getDirectory();
        for (const segment of path) {
            if (!segment || segment === '.' || segment === '..' || /[\\/]/.test(segment)) {
                throw new Error(`savestate: bad chunk directory segment ${JSON.stringify(segment)}`);
            }
            dir = await dir.getDirectoryHandle(segment, { create: true });
        }
        return new OpfsPackDir(dir);
    }

    async names(): Promise<string[]> {
        const out: string[] = [];
        for await (const name of (this.dir as unknown as { keys(): AsyncIterable<string> }).keys()) out.push(name);
        return out;
    }

    async read(name: string, from = 0, to?: number): Promise<Uint8Array | null> {
        try {
            let file = this.open.get(name);
            if (!file) this.open.set(name, file = await (await this.dir.getFileHandle(name)).getFile());
            return new Uint8Array(await file.slice(from, to).arrayBuffer());
        } catch {
            this.open.delete(name);
            return null;
        }
    }

    async write(name: string, bytes: Uint8Array): Promise<void> {
        this.open.delete(name);
        const handle = await this.dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(bytes as Uint8Array<ArrayBuffer>);
        await writable.close();
    }

    async remove(name: string): Promise<void> {
        this.open.delete(name);
        await this.dir.removeEntry(name).catch(() => undefined);
    }
}

interface PackedEntry { pack: string; from: number; length: number }
type PackIndex = { v: 1; pack: string; bytes: number; chunks: Array<[hash: string, from: number, length: number]> };

const PACK_NAME = /^p[0-9a-z]+-[0-9a-z]+\.pack$/;
const INDEX_SUFFIX = '.idx';
export const PACK_COMPACT_BELOW = 0.5;
export const PACK_MAX_BYTES = 64 * 1024 * 1024;
const LOOSE_BATCH = 256;

/**
 * Opening reads the directory and removes nothing: a pack whose index is not written yet
 * belongs to a save that is still running. Leftovers (a pack without an index, an index
 * without its pack, loose chunk files of the layout before packs) are only dealt with by
 * sweep(), which the owner calls while it holds the game lock.
 */
export class PackedChunkStore implements ChunkStore {
    private readonly entries = new Map<string, PackedEntry>();
    private readonly packs = new Map<string, { bytes: number; hashes: Set<string> }>();
    private readonly loose = new Set<string>();
    private readonly leftovers = new Set<string>();
    private serial = 0;

    private constructor(private readonly dir: PackDir, private readonly maxPackBytes: number) {}

    static async open(dir: PackDir, maxPackBytes = PACK_MAX_BYTES): Promise<PackedChunkStore> {
        const store = new PackedChunkStore(dir, maxPackBytes);
        const names = new Set(await dir.names());
        for (const name of names) {
            if (HASH_NAME.test(name)) { store.loose.add(name); continue; }
            if (!name.endsWith(INDEX_SUFFIX)) continue;
            const pack = name.slice(0, -INDEX_SUFFIX.length);
            const index = PACK_NAME.test(pack) && names.has(pack) ? parsePackIndex(await dir.read(name), pack) : null;
            if (!index) { store.leftovers.add(name); continue; }
            store.adopt(index);
        }
        for (const name of names) {
            if (PACK_NAME.test(name) && !store.packs.has(name)) store.leftovers.add(name);
        }
        return store;
    }

    /** Only under the game lock: nothing else may be between writing a pack and its index. */
    async sweep(): Promise<{ removed: number; migrated: number }> {
        const removed = this.leftovers.size;
        for (const name of this.leftovers) await this.dir.remove(name);
        this.leftovers.clear();
        const loose = [...this.loose];
        let migrated = 0;
        for (let at = 0; at < loose.length; at += LOOSE_BATCH) {
            const batch: Array<[string, Uint8Array]> = [];
            const names = loose.slice(at, at + LOOSE_BATCH);
            for (const hash of names) {
                const bytes = await this.dir.read(hash);
                if (bytes) batch.push([hash, bytes]);
            }
            for (const [hash] of batch) this.loose.delete(hash);
            try {
                await this.putMany(batch);
            } catch (e) {
                for (const [hash] of batch) this.loose.add(hash);
                throw e;
            }
            for (const hash of names) { this.loose.delete(hash); await this.dir.remove(hash); }
            migrated += batch.length;
        }
        return { removed, migrated };
    }

    private adopt(index: PackIndex): void {
        const hashes = new Set<string>();
        for (const [hash, from, length] of index.chunks) {
            if (this.entries.has(hash)) continue;
            this.entries.set(hash, { pack: index.pack, from, length });
            hashes.add(hash);
        }
        this.packs.set(index.pack, { bytes: index.bytes, hashes });
    }

    async has(hash: string): Promise<boolean> { return this.entries.has(checkHash(hash)) || this.loose.has(hash); }

    async get(hash: string): Promise<Uint8Array | null> {
        const e = this.entries.get(checkHash(hash));
        if (!e) return this.loose.has(hash) ? this.dir.read(hash) : null;
        const bytes = await this.dir.read(e.pack, e.from, e.from + e.length);
        return bytes && bytes.byteLength === e.length ? bytes : null;
    }

    async put(hash: string, bytes: Uint8Array): Promise<void> { await this.putMany([[hash, bytes]]); }

    async putMany(items: ReadonlyArray<readonly [string, Uint8Array]>): Promise<void> {
        const fresh = new Map<string, Uint8Array>();
        for (const [hash, bytes] of items) {
            if (!this.entries.has(checkHash(hash)) && !this.loose.has(hash)) fresh.set(hash, bytes);
        }
        let group: Array<[string, Uint8Array]> = [];
        let total = 0;
        for (const item of fresh) {
            if (group.length > 0 && total + item[1].byteLength > this.maxPackBytes) {
                await this.writePack(group, total);
                group = [];
                total = 0;
            }
            group.push(item);
            total += item[1].byteLength;
        }
        if (group.length > 0) await this.writePack(group, total);
    }

    private async writePack(group: ReadonlyArray<readonly [string, Uint8Array]>, total: number): Promise<void> {
        const body = new Uint8Array(total);
        const pack = `p${Date.now().toString(36)}-${(this.serial++).toString(36)}${Math.floor(Math.random() * 0x100000000).toString(36)}.pack`;
        const index: PackIndex = { v: 1, pack, bytes: total, chunks: [] };
        let at = 0;
        for (const [hash, bytes] of group) {
            body.set(bytes, at);
            index.chunks.push([hash, at, bytes.byteLength]);
            at += bytes.byteLength;
        }
        this.leftovers.add(pack);
        await this.dir.write(pack, body);
        await this.dir.write(pack + INDEX_SUFFIX, new TextEncoder().encode(JSON.stringify(index)));
        this.leftovers.delete(pack);
        this.adopt(index);
    }

    async list(): Promise<string[]> { return [...this.entries.keys(), ...this.loose]; }

    async size(hash: string): Promise<number> {
        const e = this.entries.get(checkHash(hash));
        if (e) return e.length;
        return this.loose.has(hash) ? (await this.dir.read(hash))?.byteLength ?? 0 : 0;
    }

    async delete(hash: string): Promise<void> { await this.deleteMany([hash]); }

    async deleteMany(hashes: readonly string[]): Promise<void> {
        const touched = new Set<string>();
        for (const hash of hashes) {
            if (this.loose.delete(checkHash(hash))) { await this.dir.remove(hash); continue; }
            const e = this.entries.get(hash);
            if (!e) continue;
            this.entries.delete(hash);
            this.packs.get(e.pack)?.hashes.delete(hash);
            touched.add(e.pack);
        }
        for (const pack of touched) {
            const p = this.packs.get(pack)!;
            const live = [...p.hashes].map(hash => [hash, this.entries.get(hash)!] as const);
            const liveBytes = live.reduce((n, [, e]) => n + e.length, 0);
            if (live.length > 0 && liveBytes >= p.bytes * PACK_COMPACT_BELOW) {
                const index: PackIndex = { v: 1, pack, bytes: p.bytes, chunks: live.map(([hash, e]) => [hash, e.from, e.length]) };
                await this.dir.write(pack + INDEX_SUFFIX, new TextEncoder().encode(JSON.stringify(index)));
                continue;
            }
            const moved: Array<[string, Uint8Array]> = [];
            for (const [hash, e] of live) {
                const bytes = await this.dir.read(pack, e.from, e.from + e.length);
                if (!bytes || bytes.byteLength !== e.length) throw new Error(`savestate: chunk ${hash} cannot be read from ${pack}`);
                moved.push([hash, bytes]);
            }
            for (const [hash] of live) this.entries.delete(hash);
            this.packs.delete(pack);
            await this.putMany(moved);
            await this.dir.remove(pack + INDEX_SUFFIX);
            await this.dir.remove(pack);
        }
    }
}

function parsePackIndex(bytes: Uint8Array | null, pack: string): PackIndex | null {
    if (!bytes) return null;
    try {
        const index = JSON.parse(new TextDecoder().decode(bytes)) as PackIndex;
        if (index?.v !== 1 || index.pack !== pack || !Array.isArray(index.chunks)) return null;
        if (!Number.isInteger(index.bytes) || index.bytes < 0) return null;
        for (const row of index.chunks) {
            if (!Array.isArray(row) || row.length !== 3 || !isChunkHash(row[0])) return null;
            if (!Number.isInteger(row[1]) || !Number.isInteger(row[2]) || row[1] < 0 || row[2] < 0 || row[1] + row[2] > index.bytes) return null;
        }
        return index;
    } catch {
        return null;
    }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
    let hex = '';
    for (const b of digest) hex += b.toString(16).padStart(2, '0');
    return hex;
}

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) {
                await reader.cancel().catch(() => undefined);
                throw new Error(`savestate: chunk inflates past ${limit} bytes`);
            }
            parts.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.byteLength; }
    return out;
}

const piped = (bytes: Uint8Array, stream: CompressionStream | DecompressionStream) =>
    new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream) as ReadableStream<Uint8Array>;

export const deflate = (bytes: Uint8Array) => readCapped(piped(bytes, new CompressionStream('deflate-raw')), Number.MAX_SAFE_INTEGER);
export const inflate = (bytes: Uint8Array, limit: number) => readCapped(piped(bytes, new DecompressionStream('deflate-raw')), limit);
