import { encodeValue, type SaveValue } from './value-codec';
import type { ParticipantSchema } from './container';

export interface CaptureContext {
    ref(obj: unknown, where: string): number;
}

export interface RestoreContext {
    object(ref: number): unknown;
}

export type FieldPolicy = 'save' | 'derive' | 'host' | 'transient';

export interface Participant {
    readonly id: string;
    readonly version: number;
    readonly order?: number;
    readonly covers?: readonly string[];
    readonly schema?: SaveValue;
    capture(ctx: CaptureContext): SaveValue;
    restore(state: SaveValue, ctx: RestoreContext): void | Promise<void>;
}

type SavedKeys<T, P extends Record<keyof T, FieldPolicy>> = { [K in keyof T]: P[K] extends 'save' ? K : never }[keyof T];

export function pickSaved<T, P extends Record<keyof T, FieldPolicy>>(
    record: T, policy: P,
): Pick<T, SavedKeys<T, P>> {
    const out = {} as Pick<T, SavedKeys<T, P>>;
    for (const key of Object.keys(policy) as (keyof T)[]) {
        if (policy[key] === 'save') (out as Record<keyof T, unknown>)[key] = record[key];
    }
    return out;
}

export function normalizeModuleName(name: string): string {
    return (name.split(/[\\/]/).pop() ?? name).toLowerCase().replace(/\.(dll|drv|exe)$/, '');
}

export function schemaHash(schema: SaveValue): string {
    const text = encodeValue(schema).json;
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function uncoveredModules(touched: Iterable<string>, covered: ReadonlySet<string>): string[] {
    const out = new Set<string>();
    for (const name of touched) {
        const m = normalizeModuleName(name);
        if (m && !covered.has(m)) out.add(m);
    }
    return [...out].sort();
}

export class ParticipantRegistry {
    private readonly list: Participant[] = [];

    add(participant: Participant): () => void {
        const at = this.list.findIndex(p => p.id === participant.id);
        if (at >= 0) this.list[at] = participant;
        else this.list.push(participant);
        return () => {
            const i = this.list.indexOf(participant);
            if (i >= 0) this.list.splice(i, 1);
        };
    }

    all(): readonly Participant[] {
        return [...this.list].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    }

    coveredModules(): Set<string> {
        const out = new Set<string>();
        for (const p of this.list) for (const m of p.covers ?? []) out.add(normalizeModuleName(m));
        return out;
    }

    schemas(): Record<string, ParticipantSchema> {
        const out: Record<string, ParticipantSchema> = {};
        for (const p of this.list) out[p.id] = { version: p.version, schemaHash: schemaHash(p.schema ?? null) };
        return out;
    }
}

/** @transient(behaviour, not data: owners add their participant when they are created) */
export const savestateParticipants = new ParticipantRegistry();
