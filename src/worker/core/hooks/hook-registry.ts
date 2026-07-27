/**
 * Universal guest hot-spot hook framework — registry + orchestrator.
 *
 *   hookRegistry.register(spec)            // declare a module:rva hook (at import time)
 *   hookRegistry.initialize({...})         // wire dispatcher/generator/cpu/mem (boot)
 *   hookRegistry.onModuleLoaded(module)    // from pe-loader, per PE image
 *     → for each spec whose module matches: verify prologue bytes, then patch
 *
 * The actual prologue patch is delegated to hle-lib's `applyPatch` (E9 rel32 →
 * thunk stub → ThunkDispatcher handler, with JIT invalidation). What this adds on
 * top: a module:rva spec model (no signature fingerprinting), a per-hook A/B +
 * self-time layer, a runtime enable/disable toggle, and a dev-mode correctness
 * oracle that diffs scalar vs simd output.
 */

import type { LoadedPEModule } from '../module-registry';
import { writeGuestCode } from '../memory/guest-code';
import type { ThunkDispatcher, ThunkImplementation, X86Context } from '../thunking/thunk-dispatcher';
import type { ThunkGenerator } from '../thunking/thunk-generator';
import { applyPatch, type PatchContext } from '../hle-lib/lib-patcher';
import type { PatchHandle } from '../hle-lib/types';
import type { HookSpec, HookInvocation, HookStats } from './types';

interface HookRegistryInit {
    dispatcher: ThunkDispatcher;
    thunkGenerator: ThunkGenerator;
    getMemory: () => Uint8Array | null;
}

/** All hooks patch under one dispatcher virtual module ('hook-hle'); spec.id is the unique fn name. */
const HOOK_LIB_ID = 'hook';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);

function normModuleName(name: string): string {
    return name.toLowerCase().replace(/\.dll$/, '');
}

class HookRegistry {
    private init: HookRegistryInit | null = null;
    private specs = new Map<string, HookSpec>();
    private patches = new Map<string, PatchHandle>();
    private stats = new Map<string, HookStats>();
    /** First-call validate() already ran for this spec. */
    private validated = new Set<string>();
    /** Runtime A/B override of spec.enabled() — set by setHookEnabled. */
    private enabledOverride = new Map<string, boolean>();
    /** Dev-mode: run scalar+simd and byte-diff their output every call. Off in prod. */
    private oracle = false;

    /** Declare a hook. Call at module import time (before PE load). Idempotent per id. */
    register(spec: HookSpec): void {
        if (this.specs.has(spec.id)) {
            console.warn(`[hooks] register: duplicate id '${spec.id}' — ignoring`);
            return;
        }
        this.specs.set(spec.id, spec);
        this.stats.set(spec.id, {
            id: spec.id,
            module: spec.module,
            rva: spec.rva,
            patched: false,
            unpatched: false,
            hits: 0,
            simdHits: 0,
            scalarHits: 0,
            selfTimeMs: 0,
            oracleMismatches: 0,
        });
    }

    initialize(init: HookRegistryInit): void {
        this.init = init;
    }

    isInitialized(): boolean {
        return this.init !== null;
    }

    setOracle(on: boolean): void {
        this.oracle = on;
    }

    /** Live A/B toggle for one hook (true → simd path, false → scalar). */
    setEnabled(id: string, on: boolean): boolean {
        if (!this.specs.has(id)) {
            console.warn(`[hooks] setEnabled: unknown id '${id}'`);
            return false;
        }
        this.enabledOverride.set(id, on);
        return true;
    }

    list(): HookSpec[] {
        return Array.from(this.specs.values());
    }

    private isEnabled(spec: HookSpec): boolean {
        const ovr = this.enabledOverride.get(spec.id);
        return ovr !== undefined ? ovr : spec.enabled();
    }

    /** Entry point from pe-loader. Safe before initialize() and with zero specs — both no-op. */
    onModuleLoaded(module: LoadedPEModule): void {
        if (!this.init || this.specs.size === 0) return;
        const modName = normModuleName(module.name);

        const patchCtx: PatchContext = {
            dispatcher: this.init.dispatcher,
            thunkGenerator: this.init.thunkGenerator,
            getMemory: this.init.getMemory,
        };

        for (const spec of this.specs.values()) {
            if (normModuleName(spec.module) !== modName) continue;
            if (this.patches.has(spec.id)) continue; // already patched in this run

            const mem = this.init.getMemory();
            if (!mem) {
                console.warn(`[hooks] ${spec.id}: guest memory unavailable at ${module.name} load — skipping`);
                continue;
            }

            const target = (module.baseAddress + spec.rva) >>> 0;
            if (!this.verifyPrologue(mem, target, spec.prologueVerify)) {
                console.warn(
                    `[hooks] ${spec.id}: prologue mismatch at ${module.name}+0x${spec.rva.toString(16)} ` +
                    `(0x${target.toString(16)}) — NOT patching (unrecognised build). ` +
                    `expected [${spec.prologueVerify.map(b => b.toString(16).padStart(2, '0')).join(' ')}] ` +
                    `got [${this.readBytes(mem, target, spec.prologueVerify.length).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);
                continue;
            }

            // thiscall: `this` is in ECX, stack args are callee-cleaned like stdcall.
            const conv: 'cdecl' | 'stdcall' = spec.abi.conv === 'cdecl' ? 'cdecl' : 'stdcall';
            const handle = applyPatch(patchCtx, {
                libId: HOOK_LIB_ID,
                functionName: spec.id,
                targetAddress: target,
                callingConvention: conv,
                argCount: spec.abi.argCount,
                stackCleanupBytes: spec.abi.cleanupBytes,
                handler: this.makeThunk(spec),
                // 5-byte E9 rel32 only, no NOP pad: safest against clobbering adjacent
                // code in tightly-packed images. We never branch back into the prologue.
                overwriteBytes: 5,
            });

            if (handle) {
                this.patches.set(spec.id, handle);
                const st = this.stats.get(spec.id)!;
                st.patched = true;
                console.log(
                    `[hooks] patched ${spec.id} at ${module.name}+0x${spec.rva.toString(16)} ` +
                    `(0x${target.toString(16)}) → stub 0x${handle.stubAddress.toString(16)} ` +
                    `[${conv}${spec.abi.cleanupBytes !== undefined ? ` ret ${spec.abi.cleanupBytes}` : ''}]`);
            } else {
                console.warn(`[hooks] ${spec.id}: applyPatch failed (env not ready?) — will retry on next module load`);
            }
        }
    }

    /** Wrap a spec's scalar/simd handler into a ThunkImplementation with A/B + oracle. */
    private makeThunk(spec: HookSpec): ThunkImplementation {
        return (ctx: X86Context, mem: Uint8Array, args: number[]): number => {
            const inv: HookInvocation = { ctx, mem, args };
            const st = this.stats.get(spec.id)!;
            st.hits++;

            // First-call sanity check (libjpeg pattern). On failure: unpatch for the
            // future, run the bit-exact scalar port for this call.
            if (spec.handler.validate && !this.validated.has(spec.id)) {
                this.validated.add(spec.id);
                if (!spec.handler.validate(inv)) {
                    console.warn(`[hooks] ${spec.id}: validate() failed on first call — unpatching, running scalar`);
                    this.unpatch(spec.id);
                    st.unpatched = true;
                    return this.runScalar(spec, inv, st);
                }
            }

            const useSimd = !!spec.handler.simd && this.isEnabled(spec);

            // Dev-mode correctness oracle: run BOTH paths, byte-diff their output.
            if (useSimd && this.oracle && spec.handler.outputRegion) {
                return this.runOracle(spec, inv, st);
            }

            if (useSimd) {
                st.simdHits++;
                const t0 = now();
                const r = spec.handler.simd!(inv) | 0;
                st.selfTimeMs += now() - t0;
                return r;
            }
            return this.runScalar(spec, inv, st);
        };
    }

    private runScalar(spec: HookSpec, inv: HookInvocation, st: HookStats): number {
        st.scalarHits++;
        const t0 = now();
        const r = spec.handler.scalar(inv) | 0;
        st.selfTimeMs += now() - t0;
        return r;
    }

    private runOracle(spec: HookSpec, inv: HookInvocation, st: HookStats): number {
        const region = spec.handler.outputRegion!(inv);
        if (!region || region.len <= 0) {
            // Nothing observable to diff this call — just run simd.
            st.simdHits++;
            return spec.handler.simd!(inv) | 0;
        }
        const mem = inv.mem;
        const end = region.ptr + region.len;
        const before = mem.slice(region.ptr, end);
        const rScalar = spec.handler.scalar(inv) | 0;
        const outScalar = mem.slice(region.ptr, end);
        mem.set(before, region.ptr); // restore so simd sees the same input state
        const rSimd = spec.handler.simd!(inv) | 0;
        const outSimd = mem.slice(region.ptr, end);

        if (rScalar !== rSimd || !bytesEqual(outScalar, outSimd)) {
            st.oracleMismatches++;
            const diff = firstDiff(outScalar, outSimd);
            console.error(
                `[hooks] ORACLE MISMATCH ${spec.id}: ret scalar=${rScalar} simd=${rSimd}; ` +
                (diff < 0
                    ? 'output bytes equal'
                    : `first byte diff @ +${diff} (scalar=0x${outScalar[diff].toString(16)} simd=0x${outSimd[diff].toString(16)})`));
        }
        st.simdHits++;
        return rSimd; // ship simd result; oracle only observes
    }

    private verifyPrologue(mem: Uint8Array, addr: number, expected: number[]): boolean {
        if (expected.length === 0) return true; // no guard requested
        if (addr + expected.length > mem.length) return false;
        for (let i = 0; i < expected.length; i++) {
            if (mem[addr + i] !== (expected[i] & 0xff)) return false;
        }
        return true;
    }

    private readBytes(mem: Uint8Array, addr: number, len: number): number[] {
        const out: number[] = [];
        for (let i = 0; i < len && addr + i < mem.length; i++) out.push(mem[addr + i]);
        return out;
    }

    /**
     * Restore a patched function's original bytes — future calls execute guest
     * code. Used by the validate() bail-out. Idempotent.
     */
    unpatch(id: string): boolean {
        const handle = this.patches.get(id);
        if (!handle) return false;
        const mem = this.init?.getMemory() ?? null;
        if (!mem) {
            console.warn(`[hooks] unpatch: guest memory unavailable for ${id}`);
            return false;
        }
        writeGuestCode(mem, handle.originalBytes, handle.targetAddress);
        this.patches.delete(id);
        const st = this.stats.get(id);
        if (st) st.patched = false;
        console.log(`[hooks] unpatched ${id} at 0x${handle.targetAddress.toString(16)} — restored original bytes`);
        return true;
    }

    /** Reset all runtime counters (scope a clean A/B window). Keeps specs/patches. */
    reset(): void {
        for (const st of this.stats.values()) {
            st.hits = 0;
            st.simdHits = 0;
            st.scalarHits = 0;
            st.selfTimeMs = 0;
            st.oracleMismatches = 0;
        }
    }

    getReport(): HookStats[] {
        // Snapshot so callers can't mutate internal state.
        return Array.from(this.stats.values()).map(s => ({ ...s }));
    }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function firstDiff(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
    return a.length === b.length ? -1 : n;
}

export const hookRegistry = new HookRegistry();
