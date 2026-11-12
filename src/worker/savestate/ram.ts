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

function patchesByChunk(mem: Uint8Array, patches: readonly RamPatch[]): Map<number, Array<[number, number]>> {
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
    return patched;
}

/**
 * Hashes the guest's non-zero chunks and copies only those the store does not have yet, so
 * the memory held afterwards follows the delta. It runs in one turn, so nothing can change
 * guest RAM between the participants' records and this; writing the pending chunks
 * (writeRamChunks) can run after the guest resumes.
 */
export function snapshotRam(mem: Uint8Array, known: ReadonlySet<string>, patches: readonly RamPatch[] = []): RamSnapshot {
    const count = Math.ceil(mem.length / RAM_CHUNK_SIZE);
    const patched = patchesByChunk(mem, patches);
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

export const RAM_COPY_BUDGET = 256 * 1024 * 1024;
export const RAM_COPY_BUDGET_UNKNOWN_DEVICE = 64 * 1024 * 1024;

/**
 * How much non-zero RAM a save may copy during the halt. A device that reports its memory
 * gets a sixteenth of it, at most RAM_COPY_BUDGET; one that does not (WebKit, where an
 * allocation that does not fit ends the process instead of throwing) gets the small cap.
 * The rest of the RAM is hashed in place during the halt.
 */
export function ramCopyBudget(deviceMemoryGb: unknown = (globalThis as { navigator?: { deviceMemory?: unknown } }).navigator?.deviceMemory): number {
    if (typeof deviceMemoryGb !== 'number' || !(deviceMemoryGb > 0)) return RAM_COPY_BUDGET_UNKNOWN_DEVICE;
    return Math.min(RAM_COPY_BUDGET, Math.floor(deviceMemoryGb * 1024 * 1024 * 1024 / 16));
}

export interface RamCopy {
    length: number;
    chunks: Array<[index: number, bytes: Uint8Array | null, hash: string | null]>;
    pending: Map<string, Uint8Array>;
    stats: RamCaptureStats;
    copied: number;
}

/**
 * The part of a RAM snapshot that has to run while the guest is halted: it copies the
 * non-zero chunks and leaves their hashing to hashRamCopy, which can run after the guest
 * resumes. Past `budget` copied bytes, or when a copy cannot be allocated, the remaining
 * chunks are hashed here and copied only if the store does not have them, as snapshotRam does.
 */
export function copyRam(mem: Uint8Array, known: ReadonlySet<string>, patches: readonly RamPatch[] = [], budget = ramCopyBudget()): RamCopy {
    const count = Math.ceil(mem.length / RAM_CHUNK_SIZE);
    const patched = patchesByChunk(mem, patches);
    const out: RamCopy = { length: mem.length, chunks: [], pending: new Map(), stats: { chunks: count, knownZero: 0, scannedZero: 0, written: 0, reused: 0 }, copied: 0 };
    let inline = budget <= 0;
    for (let i = 0; i < count; i++) {
        const base = i * RAM_CHUNK_SIZE;
        const size = Math.min(RAM_CHUNK_SIZE, mem.length - base);
        const fix = patched.get(i);
        if (!fix && isGuestRangeKnownZero(mem, base, size)) { out.stats.knownZero++; continue; }
        const view = mem.subarray(base, base + size);
        if (!fix && isAllZero(view)) { out.stats.scannedZero++; continue; }
        let bytes: Uint8Array | null = null;
        if (fix) {
            try { bytes = mem.slice(base, base + size); } catch (e) {
                throw new Error(`ram: the patched chunk at 0x${base.toString(16)} could not be copied (${e instanceof Error ? e.message : String(e)}); try saving again`);
            }
        } else if (!inline) {
            try { bytes = mem.slice(base, base + size); } catch { inline = true; }
        }
        if (bytes && fix) {
            for (const [off, b] of fix) bytes[off] = b;
            if (isAllZero(bytes)) { out.stats.scannedZero++; continue; }
        }
        if (bytes && !inline) {
            out.chunks.push([i, bytes, null]);
            out.copied += size;
            if (out.copied >= budget) inline = true;
            continue;
        }
        const hash = sha256HexSync(bytes ?? view);
        out.chunks.push([i, null, hash]);
        if (known.has(hash) || out.pending.has(hash)) { out.stats.reused++; continue; }
        out.pending.set(hash, bytes ?? mem.slice(base, base + size));
    }
    return out;
}

/** Hashes the chunks copyRam copied and keeps only those the store does not have yet. */
export async function hashRamCopy(copy: RamCopy, known: ReadonlySet<string>): Promise<RamSnapshot> {
    const pending = copy.pending;
    const stats = copy.stats;
    await inLanes(copy.chunks, STORE_LANES, async (entry) => {
        const bytes = entry[1];
        if (!bytes) return;
        const hash = await sha256Hex(bytes);
        entry[2] = hash;
        entry[1] = null;
        if (known.has(hash) || pending.has(hash)) { stats.reused++; return; }
        pending.set(hash, bytes);
    });
    const manifest: RamManifest = { chunkSize: RAM_CHUNK_SIZE, length: copy.length, chunks: [] };
    for (const entry of copy.chunks) manifest.chunks.push([entry[0], entry[2]!]);
    stats.written = pending.size;
    return { manifest, pending, stats };
}

export const STORE_LANES = 16;

export async function inLanes<T>(items: readonly T[], lanes: number, run: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    let failed: unknown;
    let stop = false;
    const lane = async (): Promise<void> => {
        while (!stop && next < items.length) {
            const item = items[next++]!;
            try { await run(item); } catch (e) { if (!stop) { stop = true; failed = e; } }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, items.length)) }, lane));
    if (stop) throw failed;
}

export async function writeRamChunks(pending: Map<string, Uint8Array>, store: ChunkStore, compress = true): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    const batch: Array<[string, Uint8Array]> = [];
    await inLanes([...pending], STORE_LANES, async ([hash, bytes]) => {
        const body = compress ? await deflate(bytes) : bytes;
        const file = new Uint8Array(body.byteLength + 1);
        file[0] = compress ? CODEC_DEFLATE_RAW : CODEC_RAW;
        file.set(body, 1);
        if (store.putMany) { batch.push([hash, file]); return; }
        await store.put(hash, file);
        sizes.set(hash, file.byteLength);
        pending.delete(hash);
    });
    if (store.putMany && batch.length > 0) {
        await store.putMany(batch);
        for (const [hash, file] of batch) { sizes.set(hash, file.byteLength); pending.delete(hash); }
    }
    return sizes;
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
 * Writes each chunk as soon as it is verified, so at most one chunk per lane is held at a time. A
 * failed restore leaves the guest half-written: load happens only into a fresh worker, which
 * is discarded when a load fails.
 */
export async function restoreRam(mem: Uint8Array, manifest: RamManifest, store: ChunkStore): Promise<void> {
    validateRamManifest(manifest, mem.length);
    let next = 0;
    for (const [index] of manifest.chunks) {
        const base = index * RAM_CHUNK_SIZE;
        if (base > next) zeroGuestRange(mem, next, base - next);
        next = base + Math.min(RAM_CHUNK_SIZE, mem.length - base);
    }
    if (mem.length > next) zeroGuestRange(mem, next, mem.length - next);
    await inLanes(manifest.chunks, STORE_LANES, async ([index, hash]) => {
        const base = index * RAM_CHUNK_SIZE;
        const size = Math.min(RAM_CHUNK_SIZE, mem.length - base);
        const bytes = await readChunk(store, hash, size);
        mem.set(bytes, base);
        markGuestPagesDirty(base, size);
    });
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
    const dead = (await store.list()).filter(hash => !keep.has(hash));
    if (store.deleteMany) await store.deleteMany(dead);
    else for (const hash of dead) await store.delete(hash);
    return dead.length;
}
