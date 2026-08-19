/**
 * Registry of patchers that detour EXPORTS of a real, guest-loaded PE module.
 *
 * The loader must not know which libraries we replace, so it calls
 * `runNativeModulePatchers` once per real DLL and each library registers itself. This is the
 * export-level sibling of `hookRegistry`: that one targets ONE function by (module, rva) with a
 * scalar oracle and a differential SIMD path, which does not describe replacing an export with
 * something that has no scalar equivalent (a browser decoder, say).
 *
 * Two invariants the callers depend on:
 *   - the dispatch point is AFTER the module's imports are bound, so a patched body can call
 *     back into ordinary thunks, and late enough that export thunks resolve;
 *   - one entry throwing must never stop another entry or fail the DLL load. A patcher's whole
 *     contract is "improve this module or leave it exactly as it was".
 */

import { Logger, LogCategory } from '../logger';
import type { LoadedPEModule } from '../module-registry';
import type { Process } from '../process';

export interface NativeModulePatcher {
    /** Names the entry in logs; also what a duplicate registration is keyed on. */
    id: string;
    /**
     * Whether this entry wants to look at the module at all. Omit when the library decides
     * for itself inside `patch` (some do their own multi-signal detection).
     */
    matches?: (module: LoadedPEModule) => boolean;
    patch: (process: Process, module: LoadedPEModule) => unknown;
}

const patchers: NativeModulePatcher[] = [];
/** Modules the loader has offered, newest last. In memory, so a dropped log line cannot make
 *  "the loader never dispatched" and "my patcher declined" look the same. */
const dispatched: string[] = [];

export function registerNativeModulePatcher(entry: NativeModulePatcher): void {
    const existing = patchers.findIndex((p) => p.id === entry.id);
    if (existing >= 0) patchers[existing] = entry;
    else patchers.push(entry);
}

export function nativeModulePatcherIds(): string[] {
    return patchers.map((p) => p.id);
}

/** Names of the real modules the loader has offered so far (most recent 64). */
export function nativeModulePatcherDispatches(): string[] {
    return [...dispatched];
}

/** Offer one freshly loaded real module to every registered patcher, in registration order. */
export function runNativeModulePatchers(process: Process, module: LoadedPEModule): void {
    dispatched.push(module.name);
    if (dispatched.length > 64) dispatched.shift();
    for (const entry of patchers) {
        try {
            if (entry.matches && !entry.matches(module)) continue;
            entry.patch(process, module);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM,
                `[native-patch] "${entry.id}" threw on ${module.name}: ${e} — module left unpatched`);
        }
    }
}
