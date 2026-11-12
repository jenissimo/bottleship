import { isChunkHash, sha256Hex, type ChunkStore } from './chunk-store';
import { SavestateFormatError, type Savestate } from './container';
import { inLanes, readChunk } from './ram';
import { sha256HexSync } from './sha256';

export const BLOBS = '$blobs';

/** Lanes for hashing blobs after the release: the platform digest copies its input, so each lane can hold one more copy of a large array. */
export const BLOB_HASH_LANES = 4;

export type BlobList = Array<[hash: string, length: number]>;

/** @transient(memo of content hashes by array identity: a blob's bytes never change once handed over; an entry is written during a capture or, for a deferred hash, after the guest has resumed) */
const hashes = new WeakMap<Uint8Array, string>();

export function blobHash(bytes: Uint8Array): string {
    let hash = hashes.get(bytes);
    if (hash === undefined) hashes.set(bytes, hash = sha256HexSync(bytes));
    return hash;
}

export function knownBlobHash(bytes: Uint8Array): string | undefined {
    return hashes.get(bytes);
}

/** The same name blobHash gives, computed off the worker's thread where the platform can. */
export async function blobHashLater(bytes: Uint8Array): Promise<string> {
    let hash = hashes.get(bytes);
    if (hash !== undefined) return hash;
    try { hash = await sha256Hex(bytes); } catch { hash = sha256HexSync(bytes); }
    hashes.set(bytes, hash);
    return hash;
}

/**
 * Stand-in for the name of a blob that has not been hashed yet. A capture that defers hashing
 * hands these out while the guest is halted and puts the real names in once it has resumed.
 */
export class PendingBlobs {
    private readonly prefix: string;
    private readonly pattern: RegExp;
    private readonly held: Uint8Array[] = [];
    private readonly lengths: number[] = [];
    private readonly tokens = new Map<Uint8Array, string>();
    private names: string[] | null = null;

    constructor() {
        const nonce = crypto.getRandomValues(new Uint8Array(16));
        this.prefix = `blob:${[...nonce].map(b => b.toString(16).padStart(2, '0')).join('')}:`;
        this.pattern = new RegExp(`"${this.prefix}([0-9]+)"`, 'g');
    }

    get size(): number { return this.held.length; }

    token(bytes: Uint8Array): string {
        let token = this.tokens.get(bytes);
        if (token === undefined) {
            this.tokens.set(bytes, token = this.prefix + this.held.length);
            this.held.push(bytes);
            this.lengths.push(bytes.byteLength);
        }
        return token;
    }

    async hash(lanes: number): Promise<Array<[hash: string, bytes: Uint8Array]>> {
        const names = new Array<string>(this.held.length);
        await inLanes(this.held.map((bytes, index) => ({ bytes, index })), lanes, async ({ bytes, index }) => {
            const length = this.lengths[index]!;
            const gone = (): Error => new Error(`savestate: a blob of ${length} bytes changed size after it was handed to the save; try saving again`);
            if (bytes.byteLength !== length) throw gone();
            try {
                names[index] = await blobHashLater(bytes);
            } catch (e) {
                throw new Error(`savestate: a blob of ${length} bytes could not be hashed (${e instanceof Error ? e.message : String(e)}); try saving again`);
            }
            if (bytes.byteLength !== length) throw gone();
        });
        this.names = names;
        return names.map((hash, index) => [hash, this.held[index]!]);
    }

    /** Puts the real names into one encoded section; a stand-in that is not a whole string is refused. */
    resolve(json: string, where: string): string {
        if (!json.includes(this.prefix)) return json;
        const names = this.names;
        if (!names) throw new Error('savestate: blob names are asked for before the blobs are hashed');
        const out = json.replace(this.pattern, (_all, index: string) => `"${names[Number(index)]!}"`);
        if (out.includes(this.prefix)) throw new Error(`savestate: ${where} stores a blob reference inside other text`);
        return out;
    }
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
