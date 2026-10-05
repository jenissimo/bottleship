/**
 * GetProcAddress registry — deduplicated record of export lookups the guest has
 * performed. NOT FOUND (address=0) entries are the bring-up signal: a game that
 * LoadLibrary'd a DLL then bailed on a missing export shows up here the same way
 * stubRegistry surfaces unimplemented thunks, without grepping the log firehose.
 *
 * A dynamic resolution is invisible to a PE import table, so this registry is the ONLY
 * record of that half of a title's API surface — which is exactly where legacy games
 * hide their optional and version-dependent behaviour. Recording the address alone is
 * not enough to act on: what matters is what the guest got back, so every hit also
 * carries a {@link GetProcResolution} saying whether the address leads to a real
 * handler, to a stub that will answer ERROR_NOT_SUPPORTED, to a handler that ignores
 * its arguments, or nowhere at all.
 *
 * Zero-alloc on repeat: a repeated lookup just bumps count.
 */

import { TimeService } from "../../runtime/time";

/**
 * What the returned address leads to.
 *  - `hle`         a real thunk handler.
 *  - `silent-stub` a handler that ignores its arguments (arity 0 for an export that
 *                  declares some) — returns success without doing the work.
 *  - `stub`        a generated stub with NO handler: the call answers ERROR_NOT_SUPPORTED.
 *  - `guest`       a real export inside a PE the bundle ships (or a data export).
 *  - `null`        unresolved; the guest got NULL + ERROR_PROC_NOT_FOUND.
 */
export type GetProcResolution = 'hle' | 'silent-stub' | 'stub' | 'guest' | 'null';

/** Resolutions that mean the guest did NOT get working functionality. */
export const UNSATISFIED_RESOLUTIONS: readonly GetProcResolution[] = ['silent-stub', 'stub', 'null'];

export interface GetProcAddressHit {
    /** Stable key: "0x<hModule>:<procName>". */
    key: string;
    hModule: number;
    procName: string;
    /** Resolved address; 0 = ERROR_PROC_NOT_FOUND. */
    address: number;
    /** What that address leads to. */
    kind: GetProcResolution;
    /** Owning module name when the resolver knew it ("kernel32", "d3dx9"). */
    dll?: string;
    count: number;
    firstCaller: number;
    lastCaller: number;
    firstTs: number;
    lastTs: number;
}

export interface GetProcAddressRecent {
    hModule: number;
    procName: string;
    address: number;
    kind: GetProcResolution;
    caller: number;
    ts: number;
}

const RING_SIZE = 32;

class GetProcAddressRegistry {
    private map = new Map<string, GetProcAddressHit>();
    private ring: GetProcAddressRecent[] = new Array(RING_SIZE);
    private ringWrite = 0;
    private ringCount = 0;

    record(hModule: number, procName: string, address: number, caller: number,
           kind: GetProcResolution = 'guest', dll?: string): void {
        const mod = hModule >>> 0;
        const addr = address >>> 0;
        const ret = caller >>> 0;
        const key = `0x${mod.toString(16)}:${procName}`;
        const ts = TimeService.getInstance().nowMs();

        const slot = this.ringWrite;
        this.ring[slot] = { hModule: mod, procName, address: addr, kind, caller: ret, ts };
        this.ringWrite = (slot + 1) % RING_SIZE;
        if (this.ringCount < RING_SIZE) this.ringCount++;

        const existing = this.map.get(key);
        if (existing) {
            existing.count++;
            existing.lastCaller = ret;
            existing.lastTs = ts;
            // A retried lookup can succeed after warmup/HMR; keep the latest verdict.
            existing.address = addr;
            existing.kind = kind;
            if (dll) existing.dll = dll;
            return;
        }
        this.map.set(key, {
            key,
            hModule: mod,
            procName,
            address: addr,
            kind,
            dll,
            count: 1,
            firstCaller: ret,
            lastCaller: ret,
            firstTs: ts,
            lastTs: ts,
        });
    }

    /** Distinct lookups that returned NULL (ERROR_PROC_NOT_FOUND), newest first. */
    misses(): GetProcAddressHit[] {
        return [...this.map.values()]
            .filter((h) => h.address === 0)
            .sort((a, b) => b.lastTs - a.lastTs);
    }

    /** All distinct lookups, newest first. */
    list(): GetProcAddressHit[] {
        return [...this.map.values()].sort((a, b) => b.lastTs - a.lastTs);
    }

    /**
     * Distinct resolutions the guest cannot actually use — NULL, a stub with no handler,
     * or a handler that ignores its arguments — most-used first. This is the dynamic
     * counterpart of the static census's work order: the API surface a title reached for
     * at runtime and did not get.
     */
    unsatisfied(): GetProcAddressHit[] {
        return [...this.map.values()]
            .filter((h) => UNSATISFIED_RESOLUTIONS.includes(h.kind))
            .sort((a, b) => b.count - a.count);
    }

    /** Per-resolution counts of distinct lookups — the one-glance coverage summary. */
    byKind(): Record<GetProcResolution, number> {
        const out: Record<GetProcResolution, number> =
            { hle: 0, 'silent-stub': 0, stub: 0, guest: 0, null: 0 };
        for (const h of this.map.values()) out[h.kind]++;
        return out;
    }

    /** Chronological tail of individual lookups (not deduped), oldest..newest. */
    recent(count = 16): GetProcAddressRecent[] {
        const n = Math.min(count, this.ringCount);
        if (n <= 0) return [];
        const out: GetProcAddressRecent[] = [];
        for (let i = 0; i < n; i++) {
            const idx = (this.ringWrite - n + i + RING_SIZE) % RING_SIZE;
            const entry = this.ring[idx];
            if (entry) out.push(entry);
        }
        return out;
    }

    clear(): void {
        this.map.clear();
        this.ring.fill(undefined as unknown as GetProcAddressRecent);
        this.ringWrite = 0;
        this.ringCount = 0;
    }
}

export const getProcAddressRegistry = new GetProcAddressRegistry();
