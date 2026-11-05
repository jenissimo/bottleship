import { isGuestRangeKnownZero, markGuestPagesDirty, zeroGuestRange } from '../core/memory/guest-page-dirty';
import { deflate, inflate, sha256Hex, type ChunkStore } from './chunk-store';

export const RAM_CHUNK_SIZE = 64 * 1024;

export interface RamManifest {
    chunkSize: number;
    length: number;
    compressed: boolean;
    chunks: Array<[index: number, hash: string]>;
}

export interface RamCaptureStats { chunks: number; knownZero: number; scannedZero: number; written: number; reused: number }

function isAllZero(bytes: Uint8Array): boolean {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
    for (let i = 0; i < words.length; i++) if (words[i] !== 0) return false;
    for (let i = words.length << 2; i < bytes.length; i++) if (bytes[i] !== 0) return false;
    return true;
}

export function snapshotRam(mem: Uint8Array): { length: number; chunks: Map<number, Uint8Array>; knownZero: number; scannedZero: number } {
    const chunks = new Map<number, Uint8Array>();
    let knownZero = 0, scannedZero = 0;
    const count = Math.ceil(mem.length / RAM_CHUNK_SIZE);
    for (let i = 0; i < count; i++) {
        const base = i * RAM_CHUNK_SIZE;
        const size = Math.min(RAM_CHUNK_SIZE, mem.length - base);
        if (isGuestRangeKnownZero(mem, base, size)) { knownZero++; continue; }
        const bytes = mem.slice(base, base + size);
        if (isAllZero(bytes)) { scannedZero++; continue; }
        chunks.set(i, bytes);
    }
    return { length: mem.length, chunks, knownZero, scannedZero };
}

export async function storeRam(
    snap: ReturnType<typeof snapshotRam>, store: ChunkStore, compress = true,
): Promise<{ manifest: RamManifest; stats: RamCaptureStats }> {
    const manifest: RamManifest = { chunkSize: RAM_CHUNK_SIZE, length: snap.length, compressed: compress, chunks: [] };
    const stats: RamCaptureStats = {
        chunks: Math.ceil(snap.length / RAM_CHUNK_SIZE), knownZero: snap.knownZero, scannedZero: snap.scannedZero,
        written: 0, reused: 0,
    };
    const known = new Set<string>(await store.list());
    for (const [i, bytes] of snap.chunks) {
        const hash = await sha256Hex(bytes);
        manifest.chunks.push([i, hash]);
        if (known.has(hash)) { stats.reused++; continue; }
        await store.put(hash, compress ? await deflate(bytes) : bytes);
        known.add(hash);
        stats.written++;
    }
    return { manifest, stats };
}

export async function captureRam(
    mem: Uint8Array, store: ChunkStore, compress = true,
): Promise<{ manifest: RamManifest; stats: RamCaptureStats }> {
    return storeRam(snapshotRam(mem), store, compress);
}

export async function restoreRam(mem: Uint8Array, manifest: RamManifest, store: ChunkStore): Promise<void> {
    if (manifest.chunkSize !== RAM_CHUNK_SIZE) throw new Error(`ram: chunk size ${manifest.chunkSize}`);
    if (manifest.length !== mem.length) throw new Error(`ram: snapshot holds ${manifest.length} bytes, guest has ${mem.length}`);
    const chunks = new Map<number, Uint8Array>();
    for (const [index, hash] of manifest.chunks) {
        const stored = await store.get(hash);
        if (!stored) throw new Error(`ram: chunk ${hash} is missing`);
        const bytes = manifest.compressed ? await inflate(stored) : stored;
        const size = Math.min(RAM_CHUNK_SIZE, mem.length - index * RAM_CHUNK_SIZE);
        if (bytes.length !== size || await sha256Hex(bytes) !== hash) throw new Error(`ram: chunk ${hash} is corrupt`);
        chunks.set(index, bytes);
    }
    const count = Math.ceil(mem.length / RAM_CHUNK_SIZE);
    for (let i = 0; i < count; i++) {
        const base = i * RAM_CHUNK_SIZE;
        const bytes = chunks.get(i);
        if (bytes) { mem.set(bytes, base); markGuestPagesDirty(base, bytes.length); }
        else zeroGuestRange(mem, base, Math.min(RAM_CHUNK_SIZE, mem.length - base));
    }
}

export function referencedChunks(manifests: Iterable<RamManifest>): Set<string> {
    const out = new Set<string>();
    for (const m of manifests) for (const [, hash] of m.chunks) out.add(hash);
    return out;
}

export async function collectGarbage(store: ChunkStore, live: Iterable<RamManifest>): Promise<number> {
    const keep = referencedChunks(live);
    let removed = 0;
    for (const hash of await store.list()) {
        if (!keep.has(hash)) { await store.delete(hash); removed++; }
    }
    return removed;
}
