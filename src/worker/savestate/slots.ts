import { decodeSavestate, type Savestate } from './container';
import { referencedChunks } from './ram';
import { savedBlobs } from './blobs';
import type { ChunkStore } from './chunk-store';

export interface Dir {
    list(): Promise<string[]>;
    read(name: string): Promise<Uint8Array | null>;
    write(name: string, bytes: Uint8Array): Promise<void>;
    remove(name: string): Promise<void>;
    dir(name: string, create: boolean): Promise<Dir | null>;
}

export class MemoryDir implements Dir {
    private readonly files = new Map<string, Uint8Array>();
    private readonly dirs = new Map<string, MemoryDir>();
    async list(): Promise<string[]> { return [...this.files.keys(), ...this.dirs.keys()]; }
    async read(name: string): Promise<Uint8Array | null> { return this.files.get(name)?.slice() ?? null; }
    async write(name: string, bytes: Uint8Array): Promise<void> { this.files.set(name, bytes.slice()); }
    async remove(name: string): Promise<void> { this.files.delete(name); this.dirs.delete(name); }
    async dir(name: string, create: boolean): Promise<Dir | null> {
        let d = this.dirs.get(name);
        if (!d && create) { d = new MemoryDir(); this.dirs.set(name, d); }
        return d ?? null;
    }
}

export class OpfsDir implements Dir {
    constructor(private readonly handle: FileSystemDirectoryHandle) {}

    static async open(path: readonly string[]): Promise<OpfsDir> {
        let dir = await navigator.storage.getDirectory();
        for (const segment of path) {
            if (!segment || segment === '.' || segment === '..' || /[\\/]/.test(segment)) throw new Error(`savestate: bad directory segment ${JSON.stringify(segment)}`);
            dir = await dir.getDirectoryHandle(segment, { create: true });
        }
        return new OpfsDir(dir);
    }

    get directory(): FileSystemDirectoryHandle { return this.handle; }

    async list(): Promise<string[]> {
        const out: string[] = [];
        for await (const name of (this.handle as unknown as { keys(): AsyncIterable<string> }).keys()) out.push(name);
        return out;
    }

    async read(name: string): Promise<Uint8Array | null> {
        try { return new Uint8Array(await (await (await this.handle.getFileHandle(name)).getFile()).arrayBuffer()); } catch { return null; }
    }

    async write(name: string, bytes: Uint8Array): Promise<void> {
        const tmp = `${name}.tmp`;
        const w = await (await this.handle.getFileHandle(tmp, { create: true })).createWritable();
        await w.write(bytes as Uint8Array<ArrayBuffer>);
        await w.close();
        const fh = await this.handle.getFileHandle(tmp) as FileSystemFileHandle & { move?: (name: string) => Promise<void> };
        if (fh.move) await fh.move(name);
        else {
            const w2 = await (await this.handle.getFileHandle(name, { create: true })).createWritable();
            await w2.write(bytes as Uint8Array<ArrayBuffer>);
            await w2.close();
            await this.handle.removeEntry(tmp);
        }
    }

    async remove(name: string): Promise<void> {
        await this.handle.removeEntry(name, { recursive: true }).catch(() => undefined);
    }

    async dir(name: string, create: boolean): Promise<Dir | null> {
        try { return new OpfsDir(await this.handle.getDirectoryHandle(name, { create })); } catch { return null; }
    }
}

export interface SlotInfo {
    slot: string;
    createdAt: number;
    bytes: number;
    chunkBytes: number;
    compatible: boolean;
    reasons: string[];
}

const STATE = '.bss';
const META = '.json';
const text = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

export class SlotStore {
    constructor(private readonly slots: Dir, private readonly chunks: ChunkStore) {}

    get chunkStore(): ChunkStore { return this.chunks; }

    async save(slot: string, bytes: Uint8Array, chunkBytes: number): Promise<SlotInfo> {
        const createdAt = Date.now();
        for (const name of await this.slots.list()) if (name.endsWith('.tmp')) await this.slots.remove(name);
        await this.slots.write(slot + STATE, bytes);
        await this.slots.write(slot + META, text({ createdAt, bytes: bytes.length, chunkBytes }));
        await this.collectGarbage();
        return { slot, createdAt, bytes: bytes.length, chunkBytes, compatible: true, reasons: [] };
    }

    async read(slot: string): Promise<Uint8Array | null> {
        return this.slots.read(slot + STATE);
    }

    async list(check: (state: Savestate) => string[]): Promise<SlotInfo[]> {
        const out: SlotInfo[] = [];
        for (const name of (await this.slots.list()).filter(n => n.endsWith(STATE)).sort()) {
            const slot = name.slice(0, -STATE.length);
            let meta: Partial<SlotInfo> = {};
            try { meta = JSON.parse(new TextDecoder().decode((await this.slots.read(slot + META)) ?? text({}))) as Partial<SlotInfo>; } catch { meta = {}; }
            let reasons: string[];
            try { reasons = check(decodeSavestate((await this.slots.read(name))!)); } catch (e) { reasons = [String((e as Error).message ?? e)]; }
            out.push({
                slot, createdAt: meta.createdAt ?? 0, bytes: meta.bytes ?? 0, chunkBytes: meta.chunkBytes ?? 0,
                compatible: reasons.length === 0, reasons,
            });
        }
        return out;
    }

    async remove(slot: string): Promise<number> {
        await this.slots.remove(slot + STATE);
        await this.slots.remove(slot + META);
        return this.collectGarbage();
    }

    async collectGarbage(): Promise<number> {
        const manifests = [];
        const blobs: string[] = [];
        for (const name of (await this.slots.list()).filter(n => n.endsWith(STATE))) {
            const bytes = await this.slots.read(name);
            if (!bytes) continue;
            try {
                const state = decodeSavestate(bytes);
                manifests.push(state.header.ram);
                for (const [hash] of savedBlobs(state)) blobs.push(hash);
            } catch { return 0; }
        }
        const keep = referencedChunks(manifests);
        for (const hash of blobs) keep.add(hash);
        let removed = 0;
        for (const hash of await this.chunks.list()) {
            if (!keep.has(hash)) { await this.chunks.delete(hash); removed++; }
        }
        return removed;
    }
}
