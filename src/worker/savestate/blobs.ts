import { isChunkHash, type ChunkStore } from './chunk-store';
import { SavestateFormatError, type Savestate } from './container';
import { readChunk } from './ram';
import { sha256HexSync } from './sha256';

export const BLOBS = '$blobs';

export type BlobList = Array<[hash: string, length: number]>;

/** @transient(memo of content hashes by array identity: a blob's bytes never change once handed over) */
const hashes = new WeakMap<Uint8Array, string>();

export function blobHash(bytes: Uint8Array): string {
    let hash = hashes.get(bytes);
    if (hash === undefined) hashes.set(bytes, hash = sha256HexSync(bytes));
    return hash;
}

export function savedBlobs(state: Savestate): BlobList {
    const list = state.sections.get(BLOBS) ?? [];
    if (!Array.isArray(list)) throw new SavestateFormatError('savestate: blob list is not an array');
    for (const entry of list as unknown[]) {
        const [hash, length] = Array.isArray(entry) && entry.length === 2 ? entry as [unknown, unknown] : [];
        if (!isChunkHash(hash) || typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
            throw new SavestateFormatError('savestate: bad blob entry');
        }
    }
    return list as BlobList;
}

export async function missingBlobs(list: BlobList, store: ChunkStore): Promise<string[]> {
    const out: string[] = [];
    for (const [hash] of list) if (!(await store.has(hash))) out.push(hash);
    return out;
}

export async function loadBlobs(list: BlobList, store: ChunkStore): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    for (const [hash, length] of list) out.set(hash, await readChunk(store, hash, length, 'savestate: blob'));
    return out;
}
