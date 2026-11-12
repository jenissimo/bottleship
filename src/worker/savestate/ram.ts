import { isGuestRangeKnownZero, markGuestPagesDirty, zeroGuestRange } from '../core/memory/guest-page-dirty';
import { deflate, inflate, isChunkHash, sha256Hex, type ChunkStore } from './chunk-store';
import { sha256HexSync } from './sha256';

export const RAM_CHUNK_SIZE = 64 * 1024;
export const RAM_PAGE_SIZE = 4096;
export const RAM_MAX_LENGTH = 4 * 1024 * 1024 * 1024;

const CODEC_RAW = 0;
const CODEC_DEFLATE_RAW = 1;

export interface RamManifest {
    chunkSize: number;
    length: number;
    chunks: Array<[index: number, hash: string]>;
}

export interface RamCaptureStats { chunks: number; knownZero: number; scannedZero: number; written: number; reused: number }

export interface RamSnapshot {
    manifest: RamManifest;
    pending: Map<string, Uint8Array>;
    stats: RamCaptureStats;
}

export class RamManifestError extends Error {}

export interface RamPatch { address: number; bytes: readonly number[] }

function isAllZero(bytes: Uint8Array): boolean {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
    for (let i = 0; i < words.length; i++) if (words[i] !== 0) return false;
    for (let i = words.length << 2; i < bytes.length; i++) if (bytes[i] !== 0) return false;
    return true;
}

export function validateRamManifest(manifest: unknown, guestLength?: number): RamManifest {
    const m = manifest as Partial<RamManifest> | null;
    if (m === null || typeof m !== 'object') throw new RamManifestError('ram: manifest is not an object');
    if (m.chunkSize !== RAM_CHUNK_SIZE) throw new RamManifestError(`ram: chunk size ${String(m.chunkSize)}`);
    const length = m.length;
    if (typeof length !== 'number' || !Number.isInteger(length) || length <= 0 || length > RAM_MAX_LENGTH || length % RAM_PAGE_SIZE !== 0) {
        throw new RamManifestError(`ram: bad length ${String(length)}`);
    }
    if (guestLength !== undefined && length !== guestLength) {
        throw new RamManifestError(`ram: snapshot holds ${length} bytes, guest has ${guestLength}`);
    }
    if (!Array.isArray(m.chunks)) throw new RamManifestError('ram: chunk list is not an array');
    const count = Math.ceil(length / RAM_CHUNK_SIZE);
    let previous = -1;
    for (const entry of m.chunks as unknown[]) {
        if (!Array.isArray(entry) || entry.length !== 2) throw new RamManifestError('ram: bad chunk entry');
        const [index, hash] = entry as [unknown, unknown];
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count) {
            throw new RamManifestError(`ram: chunk index ${JSON.stringify(index)} is outside 0..${count - 1}`);
        }
        if (index <= previous) throw new RamManifestError(`ram: chunk index ${index} is not after ${previous}`);
        if (!isChunkHash(hash)) throw new RamManifestError(`ram: chunk ${index} has a bad hash`);
        previous = index;
    }
    return m as RamManifest;
}

/**
 * Hashes the guest's non-zero chunks and copies only those the store does not have yet, so
 * the memory held afterwards follows the delta. It runs in one turn, so nothing can change
 * guest RAM between the participants' records and this; writing the pending chunks
 * (writeRamChunks) can run after the guest resumes.
 */
export function snapshotRam(mem: Uint8Array, known: ReadonlySet<string>, patches: readonly RamPatch[] = []): RamSnapshot {
    const count = Math.ceil(mem.length / RAM_CHUNK_SIZE);
    const patched = new Map<number, Array<[number, number]>>();
    for (const { address, bytes } of patches) {
        for (let k = 0; k < bytes.length; k++) {
            const a = address + k;
            if (a < 0 || a >= mem.length) throw new Error(`ram: patch at 0x${a.toString(16)} is outside guest memory`);
            const i = Math.floor(a / RAM_CHUNK_SIZE);
            let list = patched.get(i);
            if (!list) patched.set(i, list = []);
            list.push([a - i * RAM_CHUNK_SIZE, bytes[k]! & 0xff]);
        }
    }
    const manifest: RamManifest = { chunkSize: RAM_CHUNK_SIZE, length: mem.length, chunks: [] };
    const stats: RamCaptureStats = { chunks: count, knownZero: 0, scannedZero: 0, written: 0, reused: 0 };
    const pending = new Map<string, Uint8Array>();
    for (let i = 0; i < count; i++) {
        const base = i * RAM_CHUNK_SIZE;
        const size = Math.min(RAM_CHUNK_SIZE, mem.length - base);
        const fix = patched.get(i);
        if (!fix && isGuestRangeKnownZero(mem, base, size)) { stats.knownZero++; continue; }
        const bytes = mem.slice(base, base + size);
        if (fix) for (const [off, b] of fix) bytes[off] = b;
        if (isAllZero(bytes)) { stats.scannedZero++; continue; }
        const hash = sha256HexSync(bytes);
        manifest.chunks.push([i, hash]);
        if (known.has(hash) || pending.has(hash)) { stats.reused++; continue; }
        pending.set(hash, bytes);
    }
    stats.written = pending.size;
    return { manifest, pending, stats };
}

export async function writeRamChunks(pending: Map<string, Uint8Array>, store: ChunkStore, compress = true): Promise<void> {
    for (const [hash, bytes] of pending) {
        const body = compress ? await deflate(bytes) : bytes;
        const file = new Uint8Array(body.byteLength + 1);
        file[0] = compress ? CODEC_DEFLATE_RAW : CODEC_RAW;
        file.set(body, 1);
        await store.put(hash, file);
        pending.delete(hash);
    }
}

export async function captureRam(
    mem: Uint8Array, store: ChunkStore, compress = true,
): Promise<{ manifest: RamManifest; stats: RamCaptureStats }> {
    const snap = await snapshotRam(mem, new Set(await store.list()));
    await writeRamChunks(snap.pending, store, compress);
    return { manifest: snap.manifest, stats: snap.stats };
}

export async function readChunk(store: ChunkStore, hash: string, size: number, what = 'ram: chunk'): Promise<Uint8Array> {
    const file = await store.get(hash);
    if (!file) throw new Error(`${what} ${hash} is missing`);
    let bytes: Uint8Array;
    if (file[0] === CODEC_RAW && file.byteLength === size + 1) bytes = file.subarray(1);
    else if (file[0] === CODEC_DEFLATE_RAW) {
        try { bytes = await inflate(file.subarray(1), size); } catch { throw new Error(`${what} ${hash} is corrupt`); }
    } else throw new Error(`${what} ${hash} is corrupt`);
    if (bytes.byteLength !== size || await sha256Hex(bytes) !== hash) throw new Error(`${what} ${hash} is corrupt`);
    return bytes;
}

/**
 * Writes each chunk as soon as it is verified, so at most one chunk is held at a time. A
 * failed restore leaves the guest half-written: load happens only into a fresh worker, which
 * is discarded when a load fails.
 */
export async function restoreRam(mem: Uint8Array, manifest: RamManifest, store: ChunkStore): Promise<void> {
    validateRamManifest(manifest, mem.length);
    let next = 0;
    const zeroUpTo = (end: number) => {
        if (end > next) zeroGuestRange(mem, next, end - next);
    };
    for (const [index, hash] of manifest.chunks) {
        const base = index * RAM_CHUNK_SIZE;
        const size = Math.min(RAM_CHUNK_SIZE, mem.length - base);
        const bytes = await readChunk(store, hash, size);
        zeroUpTo(base);
        mem.set(bytes, base);
        markGuestPagesDirty(base, size);
        next = base + size;
    }
    zeroUpTo(mem.length);
}

export function referencedChunks(manifests: Iterable<RamManifest>): Set<string> {
    const out = new Set<string>();
    for (const m of manifests) for (const [, hash] of m.chunks) out.add(hash);
    return out;
}

/**
 * Deletes every chunk no kept manifest references. It must not run between a save's
 * snapshotRam and the moment that save's manifest is kept: the save reuses chunks it saw in
 * the store, and this would delete them. Saves and collection have to be serialised.
 */
export async function collectGarbage(store: ChunkStore, live: Iterable<RamManifest>): Promise<number> {
    const keep = referencedChunks(live);
    let removed = 0;
    for (const hash of await store.list()) {
        if (!keep.has(hash)) { await store.delete(hash); removed++; }
    }
    return removed;
}
