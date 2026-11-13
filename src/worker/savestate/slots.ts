import { decodeSavestate, type Savestate } from './container';
import { referencedChunks } from './ram';
import { savedBlobs } from './blobs';
import type { ChunkStore } from './chunk-store';
import { Logger, LogCategory } from '../core/logger';

export interface Dir {
    list(): Promise<string[]>;
    /** null only when the file does not exist; a file that exists and cannot be read throws. */
    read(name: string): Promise<Uint8Array | null>;
    write(name: string, bytes: Uint8Array): Promise<void>;
    /** Removing a file that does not exist is not an error; failing to remove one that does is. */
    remove(name: string): Promise<void>;
    /** null only when the directory does not exist and `create` is false. */
    dir(name: string, create: boolean): Promise<Dir | null>;
}

const isNotFound = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'NotFoundError';
const describeError = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

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

    /** A File goes stale when the file is replaced after getFile(), so one failed read is retried on a fresh File. */
    async read(name: string): Promise<Uint8Array | null> {
        for (let attempt = 0; ; attempt++) {
            let file: File;
            try {
                file = await (await this.handle.getFileHandle(name)).getFile();
            } catch (e) {
                if (isNotFound(e)) return null;
                throw new Error(`savestate: ${name} cannot be opened (${describeError(e)})`, { cause: e });
            }
            try {
                return new Uint8Array(await file.arrayBuffer());
            } catch (e) {
                if (attempt === 0) continue;
                throw new Error(`savestate: ${name} cannot be read (${describeError(e)})`, { cause: e });
            }
        }
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
        try {
            await this.handle.removeEntry(name, { recursive: true });
        } catch (e) {
            if (!isNotFound(e)) throw new Error(`savestate: ${name} cannot be removed (${describeError(e)})`, { cause: e });
        }
    }

    async dir(name: string, create: boolean): Promise<Dir | null> {
        try {
            return new OpfsDir(await this.handle.getDirectoryHandle(name, { create }));
        } catch (e) {
            if (!create && isNotFound(e)) return null;
            throw new Error(`savestate: directory ${name} cannot be opened (${describeError(e)})`, { cause: e });
        }
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
        for (const name of await this.slots.list()) {
            if (name.endsWith('.tmp')) await this.slots.remove(name).catch(() => undefined);
        }
        await this.slots.write(slot + STATE, bytes);
        await this.slots.write(slot + META, text({ createdAt, bytes: bytes.length, chunkBytes }));
        await this.collectAfter('save');
        return { slot, createdAt, bytes: bytes.length, chunkBytes, compatible: true, reasons: [] };
    }

    async read(slot: string): Promise<Uint8Array | null> {
        return this.slots.read(slot + STATE);
    }

    async list(check: (state: Savestate) => string[]): Promise<SlotInfo[]> {
        const out: SlotInfo[] = [];
        for (const name of (await this.slots.list()).filter(n => n.endsWith(STATE)).sort()) {
            const slot = name.slice(0, -STATE.length);
            let bytes: Uint8Array | null = null;
            let readError: string | null = null;
            try { bytes = await this.slots.read(name); } catch (e) { readError = describeError(e); }
            if (!bytes && readError === null) continue;
            let meta: Partial<SlotInfo> = {};
            try { meta = JSON.parse(new TextDecoder().decode((await this.slots.read(slot + META)) ?? text({}))) as Partial<SlotInfo>; } catch { meta = {}; }
            let reasons: string[];
            if (readError !== null) reasons = [readError];
            else try { reasons = check(decodeSavestate(bytes!)); } catch (e) { reasons = [String((e as Error).message ?? e)]; }
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
        return this.collectAfter('delete');
    }

    /** The slot itself is already written or removed; a collection that cannot run is reported and retried by the next save or delete. */
    private async collectAfter(what: string): Promise<number> {
        try {
            return await this.collectGarbage();
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `[SAVESTATE] chunk collection after the ${what} was skipped, nothing was removed: ${e instanceof Error ? e.message : String(e)}`);
            return 0;
        }
    }

    /**
     * Removes the chunks no slot references. Every slot's state is read and parsed first; one that
     * exists but cannot be read or parsed throws before anything is removed.
     */
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
            } catch (e) {
                throw new Error(`savestate: ${name} cannot be parsed, so no chunk is collected (${describeError(e)})`, { cause: e });
            }
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
