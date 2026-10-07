export type WgbIoMode = "stream" | "stream+fill" | "preload-profile" | "preload-full";
export interface WgbIoPolicy { mode?: WgbIoMode; profileUrl?: string; preloadPhases?: string[] }
export interface WgbIoProfile {
    version: 1;
    size: number;
    granuleBytes: number;
    url?: string;
    etag?: string | null;
    accesses: Array<{ granule: number; ms: number; phase: string; entryName?: string }>;
    files?: Array<{ entryName: string; ms: number; phase: string }>;
}

export function parseIoProfile(value: unknown): WgbIoProfile {
    const p = value as WgbIoProfile;
    if (p?.version !== 1 || !Number.isSafeInteger(p.size) || p.size <= 0
        || !Number.isSafeInteger(p.granuleBytes) || p.granuleBytes <= 0 || !Array.isArray(p.accesses)
        || p.accesses.length > Math.ceil(p.size / p.granuleBytes)) throw new Error("Invalid WGB I/O profile");
    for (const a of p.accesses) {
        if (!Number.isSafeInteger(a.granule) || a.granule < 0 || a.granule * p.granuleBytes >= p.size
            || !Number.isFinite(a.ms) || a.ms < 0 || typeof a.phase !== "string"
            || (a.entryName !== undefined && typeof a.entryName !== "string")) throw new Error("Invalid WGB I/O profile access");
    }
    if (p.files !== undefined) {
        if (!Array.isArray(p.files) || p.files.length > p.size / 30) throw new Error("Invalid WGB I/O profile files");
        for (const f of p.files) {
            if (typeof f.entryName !== "string" || !f.entryName || !Number.isFinite(f.ms) || f.ms < 0
                || typeof f.phase !== "string") throw new Error("Invalid WGB I/O profile file");
        }
    }
    return p;
}

export function profileChunkOrder(p: WgbIoProfile, chunkBytes: number, phases?: string[]): number[] {
    const order = new Set<number>();
    for (const access of p.accesses) {
        if (phases && !phases.includes(access.phase)) continue;
        const start = access.granule * p.granuleBytes;
        const end = Math.min(p.size, start + p.granuleBytes);
        for (let ci = Math.floor(start / chunkBytes); ci * chunkBytes < end; ci++) order.add(ci);
    }
    return [...order];
}

/** Filename order survives repacking, unlike the old archive's byte offsets. */
export function orderFilesByProfile<T>(files: Map<string, T>, p: WgbIoProfile): Array<[string, T]> {
    const rank = new Map<string, number>();
    for (const access of p.files ?? p.accesses) {
        const name = access.entryName?.replace(/\\/g, "/").toLowerCase();
        if (name && !rank.has(name)) rank.set(name, rank.size);
    }
    return [...files].sort(([a], [b]) => (rank.get(a.toLowerCase()) ?? Infinity) - (rank.get(b.toLowerCase()) ?? Infinity));
}
