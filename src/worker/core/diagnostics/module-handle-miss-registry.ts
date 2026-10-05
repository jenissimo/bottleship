/**
 * Deduplicated record of GetModuleHandle* lookups that answered NULL.
 *
 * A module handle the guest could not get is a fork in its control flow, and usually the
 * LAST one before it gives up — a crash handler that cannot find the DLL it wanted to
 * report through, a mod loader that skips its payload, an optional-feature probe that
 * disables the feature. The name is already logged, but a log line is gone long before a
 * late crash: this is the sibling of the GetProcAddress miss registry, so a fault snapshot
 * can NAME the module instead of leaving "GetModuleHandleA -> 0" in the thunk ring with no
 * argument attached.
 *
 * Zero-alloc on repeat: a repeated lookup just bumps count.
 */

import { TimeService } from "../../runtime/time";

export interface ModuleHandleMiss {
    /** The name as the guest spelled it. */
    name: string;
    /** "GetModuleHandleA" / "GetModuleHandleW" / "GetModuleHandleExA"… */
    api: string;
    count: number;
    firstCaller: number;
    lastCaller: number;
    firstTs: number;
    lastTs: number;
}

class ModuleHandleMissRegistry {
    private map = new Map<string, ModuleHandleMiss>();

    record(api: string, name: string, caller: number): void {
        const ret = caller >>> 0;
        const ts = TimeService.getInstance().nowMs();
        const key = `${api}:${name.toLowerCase()}`;

        const existing = this.map.get(key);
        if (existing) {
            existing.count++;
            existing.lastCaller = ret;
            existing.lastTs = ts;
            return;
        }
        this.map.set(key, { name, api, count: 1, firstCaller: ret, lastCaller: ret, firstTs: ts, lastTs: ts });
    }

    /** Distinct misses, newest last seen first. */
    list(): ModuleHandleMiss[] {
        return [...this.map.values()].sort((a, b) => b.lastTs - a.lastTs);
    }

    clear(): void {
        this.map.clear();
    }
}

export const moduleHandleMissRegistry = new ModuleHandleMissRegistry();
