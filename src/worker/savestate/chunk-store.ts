export interface ChunkStore {
    has(hash: string): Promise<boolean>;
    get(hash: string): Promise<Uint8Array | null>;
    put(hash: string, bytes: Uint8Array): Promise<void>;
    list(): Promise<string[]>;
    delete(hash: string): Promise<void>;
    size(hash: string): Promise<number>;
}

export class MemoryChunkStore implements ChunkStore {
    readonly chunks = new Map<string, Uint8Array>();
    async has(hash: string): Promise<boolean> { return this.chunks.has(hash); }
    async get(hash: string): Promise<Uint8Array | null> { return this.chunks.get(hash)?.slice() ?? null; }
    async put(hash: string, bytes: Uint8Array): Promise<void> { this.chunks.set(hash, bytes.slice()); }
    async list(): Promise<string[]> { return [...this.chunks.keys()]; }
    async delete(hash: string): Promise<void> { this.chunks.delete(hash); }
    async size(hash: string): Promise<number> { return this.chunks.get(hash)?.length ?? 0; }
}

const HASH_NAME = /^[0-9a-f]{64}$/;

export class OpfsChunkStore implements ChunkStore {
    private constructor(private readonly dir: FileSystemDirectoryHandle) {}

    static async open(name = 'savestate-chunks'): Promise<OpfsChunkStore> {
        const root = await navigator.storage.getDirectory();
        return new OpfsChunkStore(await root.getDirectoryHandle(name, { create: true }));
    }

    async has(hash: string): Promise<boolean> {
        try { await this.dir.getFileHandle(hash); return true; } catch { return false; }
    }

    async get(hash: string): Promise<Uint8Array | null> {
        try {
            const file = await (await this.dir.getFileHandle(hash)).getFile();
            return new Uint8Array(await file.arrayBuffer());
        } catch { return null; }
    }

    async put(hash: string, bytes: Uint8Array): Promise<void> {
        const handle = await this.dir.getFileHandle(hash, { create: true });
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
        await this.dir.removeEntry(hash).catch(() => undefined);
    }

    async size(hash: string): Promise<number> {
        try { return (await (await this.dir.getFileHandle(hash)).getFile()).size; } catch { return 0; }
    }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
    let hex = '';
    for (const b of digest) hex += b.toString(16).padStart(2, '0');
    return hex;
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
    const out = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
}

export const deflate = (bytes: Uint8Array) => transform(bytes, new CompressionStream('deflate-raw'));
export const inflate = (bytes: Uint8Array) => transform(bytes, new DecompressionStream('deflate-raw'));
