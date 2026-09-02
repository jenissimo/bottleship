/**
 * Canonical fixed-width identity for the WASM arena programmable-pipeline key.
 *
 * The arena command still transports a compact u32 FNV key, but the Rust side
 * hashes every word below before adding its legacy state fields. Keeping the
 * canonical input fixed-width avoids locale/string parsing differences between
 * the JS and Rust halves of the ABI. The caller is responsible for putting all
 * semantic pipeline-cache fields into the canonical serialization.
 */
export const D3D9_ARENA_PIPELINE_IDENTITY_WORDS = 16;
export const D3D9_ARENA_TEXTURE_CUBE_FLAG_SLOTS = 4096;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export interface ArenaPipelineIdentitySnapshot {
    /** Canonical serialized key used for the collision-safe JS cache bucket. */
    key: string;
    /** The 16 Rust ABI lanes, computed as the key is assembled. */
    words: Uint32Array;
}

/** Named fragments make the completeness contract auditable and table-testable. Keep the
 * order stable: it is part of the canonical identity consumed by the Rust arena. */
export interface ArenaPipelineIdentityFields {
    shader: string;
    fvf: string;
    state: string;
    point: string;
    blend: string;
    masks: string;
    projection: string;
    sampler: string;
    target: string;
    streams: string;
}

// Pipeline identities are deliberately content-addressed: a cache hit is only possible after
// the complete canonical string compares equal.  Real D3D9 frames revisit a very small set of
// blend/depth/shader variants thousands of times, while hashing one identity costs sixteen full
// FNV passes in parallel.  Keep the cache bounded because shader/state churn is guest-controlled.
const IDENTITY_WORD_CACHE_LIMIT = 4096;
const identityWordCache = new Map<string, Uint32Array>();

function fnvWord(hash: number, word: number): number {
    return Math.imul((hash ^ (word >>> 0)) >>> 0, FNV_PRIME) >>> 0;
}

function seededIdentityWords(): Uint32Array {
    const words = new Uint32Array(D3D9_ARENA_PIPELINE_IDENTITY_WORDS);
    for (let lane = 0; lane < words.length; lane++) {
        let h = (FNV_OFFSET ^ Math.imul(lane + 1, 0x9e3779b9)) >>> 0;
        h ^= lane;
        words[lane] = Math.imul(h, FNV_PRIME) >>> 0;
    }
    return words;
}

/**
 * Incremental identity builder: each canonical fragment is appended once and every lane is
 * updated in that same character walk; `finish()` returns the fixed-width ABI words while
 * retaining the readable key for cache diagnostics.
 */
export class ArenaPipelineIdentityBuilder {
    private readonly words = seededIdentityWords();
    private key = "";

    append(fragment: string): this {
        this.key += fragment;
        for (let i = 0; i < fragment.length; i++) {
            const c = fragment.charCodeAt(i);
            for (let lane = 0; lane < this.words.length; lane++) {
                let h = this.words[lane]!;
                h ^= c & 0xff;
                h = Math.imul(h, FNV_PRIME) >>> 0;
                h ^= c >>> 8;
                this.words[lane] = Math.imul(h, FNV_PRIME) >>> 0;
            }
        }
        return this;
    }

    finish(): ArenaPipelineIdentitySnapshot {
        // A copy: nothing downstream may alias the builder's lanes (the device retains the
        // words for a whole state run, and the arena publishes them verbatim).
        return { key: this.key, words: new Uint32Array(this.words) };
    }
}

/** Assemble the complete identity from semantically named cache fragments. */
export function buildArenaPipelineIdentity(fields: ArenaPipelineIdentityFields): ArenaPipelineIdentitySnapshot {
    const key = fields.shader + fields.fvf + fields.state + fields.point + fields.blend
        + fields.masks + fields.projection + fields.sampler + fields.target + fields.streams;
    const cached = identityWordCache.get(key);
    if (cached !== undefined) {
        // Preserve the builder's ownership contract: callers may retain or mutate their snapshot
        // without corrupting a future cache hit.
        return { key, words: new Uint32Array(cached) };
    }

    const words = new ArenaPipelineIdentityBuilder().append(key).finish().words;
    if (identityWordCache.size >= IDENTITY_WORD_CACHE_LIMIT) identityWordCache.clear();
    identityWordCache.set(key, words);
    return { key, words: new Uint32Array(words) };
}

/** Stable FNV-1a lanes over a canonical string. */
export function hashArenaPipelineIdentity(serialized: string): Uint32Array {
    return new ArenaPipelineIdentityBuilder().append(serialized).finish().words;
}

/** Collision-safe cache bucket key. */
export function arenaPipelineCacheBucket(arenaKey: number, fingerprint: string): string {
    return `${arenaKey >>> 0}:${fingerprint}`;
}
