export interface ChunkStore {
    has(hash: string): Promise<boolean>;
    get(hash: string): Promise<Uint8Array | null>;
    put(hash: string, bytes: Uint8Array): Promise<void>;
    list(): Promise<string[]>;
    delete(hash: string): Promise<void>;
    size(hash: string): Promise<number>;
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

export class OpfsChunkStore implements ChunkStore {
    private constructor(private readonly dir: FileSystemDirectoryHandle) {}

    static async open(path: readonly string[], root?: FileSystemDirectoryHandle): Promise<OpfsChunkStore> {
        let dir = root ?? await navigator.storage.getDirectory();
        for (const segment of path) {
            if (!segment || segment === '.' || segment === '..' || /[\\/]/.test(segment)) {
                throw new Error(`savestate: bad chunk directory segment ${JSON.stringify(segment)}`);
            }
            dir = await dir.getDirectoryHandle(segment, { create: true });
        }
        return new OpfsChunkStore(dir);
    }

    async has(hash: string): Promise<boolean> {
        try { await this.dir.getFileHandle(checkHash(hash)); return true; } catch { return false; }
    }

    async get(hash: string): Promise<Uint8Array | null> {
        checkHash(hash);
        try {
            const file = await (await this.dir.getFileHandle(hash)).getFile();
            return new Uint8Array(await file.arrayBuffer());
        } catch { return null; }
    }

    async put(hash: string, bytes: Uint8Array): Promise<void> {
        const handle = await this.dir.getFileHandle(checkHash(hash), { create: true });
        const writable = await handle.createWritable();
        await writable.write(bytes as Uint8Array<ArrayBuffer>);
        await writable.close();
    }

    async list(): Promise<string[]> {
        const out: string[] = [];
        for await (const name of (this.dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
            if (HASH_NAME.test(name)) out.push(name);
        }
        return out;
    }

    async delete(hash: string): Promise<void> {
        await this.dir.removeEntry(checkHash(hash)).catch(() => undefined);
    }

    async size(hash: string): Promise<number> {
        try { return (await (await this.dir.getFileHandle(checkHash(hash))).getFile()).size; } catch { return 0; }
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
