import type { SaveValue } from './value-codec';
import type { RestoreContext } from './participant';
import { blobHash } from './blobs';

export interface ObjectCodec<T = unknown> {
    readonly tag: string;
    matches(obj: unknown): obj is T;
    capture(obj: T, ref: (o: unknown, where: string) => number, blob: (bytes: Uint8Array) => string): unknown;
    restore(data: never, ctx: RestoreContext): T;
    link?(obj: T, data: never, ctx: RestoreContext): void;
}

export class ObjectCodecRegistry {
    private readonly codecs: ObjectCodec[] = [];

    add<T>(codec: ObjectCodec<T>): void {
        const at = this.codecs.findIndex(c => c.tag === codec.tag);
        if (at >= 0) this.codecs[at] = codec as ObjectCodec;
        else this.codecs.push(codec as ObjectCodec);
    }

    codecFor(obj: unknown): ObjectCodec | null {
        return this.codecs.find(c => c.matches(obj)) ?? null;
    }

    byTag(tag: string): ObjectCodec | null {
        return this.codecs.find(c => c.tag === tag) ?? null;
    }
}

/** @transient(behaviour, not data: owners add their codecs when they are created) */
export const objectCodecs = new ObjectCodecRegistry();


export class CaptureRefusal extends Error {}

export interface ObjectGraph {
    objects: Array<[string, SaveValue]>;
    blobs: Map<string, Uint8Array>;
    ref(obj: unknown, where: string): number;
    blob(bytes: Uint8Array): string;
}

export function newObjectGraph(): ObjectGraph {
    const ids = new Map<unknown, number>();
    const objects: Array<[string, SaveValue]> = [];
    const blobs = new Map<string, Uint8Array>();
    const blob = (bytes: Uint8Array): string => {
        const hash = blobHash(bytes);
        if (!blobs.has(hash)) blobs.set(hash, bytes);
        return hash;
    };
    const graph: ObjectGraph = {
        objects,
        blobs,
        blob,
        ref(obj: unknown, where: string): number {
            const known = ids.get(obj);
            if (known !== undefined) return known;
            const codec = objectCodecs.codecFor(obj);
            if (!codec) {
                const name = (obj as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof obj;
                const kind = (obj as { kind?: unknown } | null)?.kind;
                throw new CaptureRefusal(`${where}: no savestate codec for ${name}${kind ? ` (${String(kind)})` : ''}`);
            }
            const id = objects.length;
            ids.set(obj, id);
            objects.push([codec.tag, null]);
            objects[id] = [codec.tag, codec.capture(obj, (o, w) => graph.ref(o, `${where} > ${w}`), blob) as SaveValue];
            return id;
        },
    };
    return graph;
}

export function restoreObjectGraph(
    objects: Array<[string, SaveValue]>, blobs: ReadonlyMap<string, Uint8Array> = new Map(),
): RestoreContext {
    const live = new Map<number, unknown>();
    const ctx: RestoreContext = {
        blob(hash: string): Uint8Array {
            const bytes = blobs.get(hash);
            if (!bytes) throw new Error(`savestate: blob ${hash} is missing`);
            return bytes;
        },
        object(ref: number): unknown {
            if (live.has(ref)) return live.get(ref);
            const entry = objects[ref];
            if (!entry) throw new Error(`savestate: object ${ref} is missing`);
            const codec = objectCodecs.byTag(entry[0]);
            if (!codec) throw new Error(`savestate: no codec ${entry[0]} in this build`);
            const obj = (codec.restore as (d: SaveValue, c: RestoreContext) => unknown)(entry[1], ctx);
            live.set(ref, obj);
            (codec.link as ((o: unknown, d: SaveValue, c: RestoreContext) => void) | undefined)?.(obj, entry[1], ctx);
            return obj;
        },
    };
    return ctx;
}
