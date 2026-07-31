/**
 * Orchestrator for static-library HLE. Called from the PE loader after each
 * module finishes loading (post-relocations, post-imports, post-registration).
 *
 *   libHleManager.onModuleLoaded(module)
 *     → for each registered descriptor: run detector
 *     → if confidence ≥ threshold: patch each function, register handler
 *     → record in `matches` for diagnostics
 */

import { Logger, LogCategory } from '../logger';
import { System } from '../system';
import { hypercallDataManager } from '../cpu/hypercall-data';

// Side-effect: auto-registers every libs/<id> descriptor (Vite glob barrel) —
// the manager owning this guarantees descriptors exist before any detection.
import './libs';
import type { LoadedPEModule } from '../module-registry';
import type { ThunkDispatcher, ThunkImplementation, ThunkResult } from '../thunking/thunk-dispatcher';
import type { ThunkGenerator } from '../thunking/thunk-generator';
import { EmulatorConfig } from '../emulator-config-manager';
import { runDetector } from './lib-detector';
import { libRegistry } from './lib-registry';
import { applyPatch, PatchContext } from './lib-patcher';
import {
    LiveShadowView,
    ScratchShadowView,
    ShadowHookRuntime,
    compareShadowOutputs,
    rangesAreSane,
} from './shadow-validator';
import {
    callGuestFunctionSync,
    writeSentinelBytes,
    type SyncCallEnv,
    type SyncCallResult,
} from './sync-guest-call';
import { preemptionManager } from '../cpu/preemption-manager';
import { writeGuestCode } from '../memory/guest-code';
import { MEM_THUNK_CODE_BASE, MEM_ROM_BASE } from '../cpu/emulator-config';
import type { HleReportEntry, HookedFunction, LibMatch, PatchHandle, ShadowHookStatus, ShadowSite, ShadowSpec } from './types';

interface ManagerInit {
    dispatcher: ThunkDispatcher;
    thunkGenerator: ThunkGenerator;
    /** Late-bound so we can grab a fresh cpu handle at patch time. */
    getCpu: () => any;
    getMemory: () => Uint8Array | null;
}

class LibHleManager {
    private init: ManagerInit | null = null;
    /** Recorded matches by libId (module name → LibMatch) for diagnostics. */
    private matches = new Map<string, Map<string, LibMatch>>();
    /**
     * Patches applied, keyed by (libId, MODULE, functionName). The module component is not
     * bookkeeping tidiness: one static library routinely appears in two modules of a process
     * (linked into an engine DLL and into the exe), and without it the second copy's patch
     * overwrites the first's originalBytes/targetAddress/trampoline — after which unpatch
     * restores only one of them while the other keeps jumping into a stub whose runtime is
     * already disabled.
     */
    private patches = new Map<string, PatchHandle>();
    /** Per-(libId, functionName) hit counters — an aggregate across modules (diagnostics only). */
    private hits = new Map<string, Map<string, number>>();
    /** Shadow state machines, one per PATCH (same key space as `patches`). */
    private shadowRuntimes = new Map<string, ShadowHookRuntime>();
    /** Lazily-allocated return-sentinel for the sync original-call path. */
    private sentinelAddress = 0;
    /** One-shot log latch: run_guest_until missing from the wasm build. */
    private warnedNoExport = false;

    initialize(init: ManagerInit): void {
        this.init = init;
    }

    isInitialized(): boolean {
        return this.init !== null;
    }

    private static patchKey(libId: string, moduleName: string, functionName: string): string {
        return `${libId}|${moduleName}|${functionName}`;
    }

    /**
     * Find the patch for (libId, functionName). `moduleName` selects one exactly; without it
     * the lookup only succeeds when a single module carries the function — an ambiguous
     * request is refused loudly rather than served from an arbitrary module.
     */
    private resolvePatch(libId: string, functionName: string, moduleName?: string): PatchHandle | undefined {
        if (moduleName !== undefined) {
            return this.patches.get(LibHleManager.patchKey(libId, moduleName, functionName));
        }
        let found: PatchHandle | undefined;
        let count = 0;
        for (const h of this.patches.values()) {
            if (h.libId !== libId || h.functionName !== functionName) continue;
            found = h;
            count++;
        }
        if (count > 1) {
            Logger.error(LogCategory.SYSTEM,
                `[HLE-lib] ${libId}:${functionName} is patched in ${count} modules — ` +
                `this call must name the module`);
            return undefined;
        }
        return found;
    }

    /**
     * Expose the CallbackManager for HLE handlers that need to invoke guest
     * callbacks (e.g. libjpeg's source_mgr.fill_input_buffer). Throws if the
     * manager isn't initialized yet — handlers can only run once detection
     * has fired, so this should always be safe from handler context.
     */
    get callbackManager() {
        if (!this.init) throw new Error('[HLE-lib] callbackManager accessed before initialize');
        return this.init.dispatcher.callbackManager;
    }

    /**
     * The live ThunkDispatcher, for library modules that need runtime plumbing
     * (e.g. the EAGL token-dispatch hook reads the WBUF ring / setter-shadow
     * addresses to assemble its WASM-handler config). Null before initialize.
     */
    get dispatcher(): ThunkDispatcher | null {
        return this.init?.dispatcher ?? null;
    }

    /**
     * Run a patched function's ORIGINAL through its trampoline, synchronously —
     * public variant for library handlers' RARE bail/decline paths (structural
     * doubt, transient resource exhaustion). `noAbortRange` disables the
     * thunk-region abort gate: use it ONLY for originals that legitimately
     * execute THUNK_CODE-resident trampolines (e.g. the EAGL dispatcher calling
     * our WBUF setter trampolines); such a call may re-enter the JS dispatcher
     * if the guest path OUT-traps, so callers must treat failure as survivable.
     */
    callOriginalSync(
        libId: string,
        functionName: string,
        callArgs: number[],
        convention: 'stdcall' | 'cdecl' = 'stdcall',
        noAbortRange = false,
        moduleName?: string,
    ): SyncCallResult {
        const handle = this.resolvePatch(libId, functionName, moduleName);
        if (!handle || handle.trampolineAddress === undefined) return { ok: false, reason: 'no-export' };
        const env = this.syncEnv();
        if (!env) return { ok: false, reason: 'no-export' };
        const effEnv = noAbortRange ? { ...env, abortLo: 0, abortHi: 0 } : env;
        return callGuestFunctionSync(effEnv, handle.trampolineAddress, callArgs, convention);
    }

    /** Entry point from pe-loader. Safe to call before initialize — will no-op. */
    onModuleLoaded(module: LoadedPEModule): void {
        if (!this.init) {
            Logger.log(LogCategory.SYSTEM, `[HLE-lib] onModuleLoaded(${module.name}) — manager not yet initialized, skipping`);
            return;
        }
        const cfg = EmulatorConfig.getInstance().hleLibs;
        if (!cfg.enable) return;

        const descriptors = libRegistry.getAll();
        if (descriptors.length === 0) {
            Logger.warn(LogCategory.SYSTEM, `[HLE-lib] onModuleLoaded(${module.name}) — no descriptors registered; did libs/*/index.ts import?`);
            return;
        }

        const sectionSummary = (module.sections ?? []).map(s =>
            `${s.name}(${s.virtualSize}B@0x${s.virtualAddress.toString(16)})`).join(', ');
        Logger.log(LogCategory.SYSTEM, `[HLE-lib] onModuleLoaded ${module.name} base=0x${module.baseAddress.toString(16)} size=${module.size} sections=[${sectionSummary}]`);

        for (const desc of descriptors) {
            // Per-library opt-out.
            const libCfg = (cfg as any)[desc.id] as { enable?: boolean } | undefined;
            if (libCfg && libCfg.enable === false) continue;

            const threshold = cfg.minConfidence ?? desc.minConfidence;
            const match = runDetector(desc, module);
            if (!match) {
                Logger.log(LogCategory.SYSTEM, `[HLE-lib] ${desc.id} in ${module.name}: no detection (0 hits or required function missing)`);
                continue;
            }
            if (match.confidence < threshold) {
                const hits = match.signatureHits.map(h => `${h.signatureId}(+${h.weight})`).join(', ');
                Logger.log(LogCategory.SYSTEM, `[HLE-lib] ${desc.id} in ${module.name}: confidence ${match.confidence} < threshold ${threshold}. Hits: [${hits}]`);
                continue;
            }

            Logger.log(LogCategory.SYSTEM,
                `[HLE-lib] Detected '${desc.id}' in ${module.name} (confidence ${match.confidence}, ` +
                `${match.functionMatches.length} functions resolved` +
                (match.missingFunctions.length > 0 ? `, ${match.missingFunctions.length} missing: ${match.missingFunctions.join(', ')}` : '') +
                `)`);

            // Record the match for diagnostics regardless of logOnly.
            if (!this.matches.has(desc.id)) this.matches.set(desc.id, new Map());
            this.matches.get(desc.id)!.set(module.name, match);
            Logger.log(LogCategory.SYSTEM, `[HLE-lib] ${desc.id} function addresses: ` +
                match.functionMatches.map(f => `${f.name}=0x${f.address.toString(16)}`).join(' '));

            if (cfg.logOnly) {
                Logger.log(LogCategory.SYSTEM, `[HLE-lib] logOnly=true — '${desc.id}' detected but NOT patching`);
                continue;
            }

            this.applyMatch(match);
        }
    }

    private applyMatch(match: LibMatch): void {
        if (!this.init) return;
        const { descriptor, module, functionMatches } = match;

        const patchCtx: PatchContext = {
            dispatcher: this.init.dispatcher,
            thunkGenerator: this.init.thunkGenerator,
            getMemory: this.init.getMemory,
        };

        for (const fm of functionMatches) {
            const decl = descriptor.functions[fm.name];
            const key = LibHleManager.patchKey(descriptor.id, module.name, fm.name);

            // Guarded Inner-Loop HLE: shadow-enabled hooks derive their handler
            // from the kernel. The trampoline (prologueLen) is only needed for
            // the in-game validation round-trip; the default direct-kernel path
            // does not touch it.
            let handler = descriptor.handlers[fm.name];
            let runtime: ShadowHookRuntime | null = null;
            const needsTrampoline = decl.shadow?.validateInGame === true;
            if (decl.shadow) {
                if (needsTrampoline && decl.prologueLen === undefined) {
                    Logger.error(LogCategory.SYSTEM,
                        `[HLE-lib] ${descriptor.id}:${fm.name} sets validateInGame but no prologueLen — ` +
                        `the original-call path is impossible; skipping hook`);
                    continue;
                }
                runtime = new ShadowHookRuntime(
                    descriptor.id, fm.name, decl.shadow,
                    () => { this.unpatch(descriptor.id, fm.name, module.name); },
                    // VALIDATED (shadowing→active): promote to the WASM
                    // hypercall tier — the production home for inner-loop
                    // kernels (JS at kilo-calls/frame is a net regression).
                    () => {
                        const h = this.patches.get(key);
                        if (decl.hypercallHandlerId !== undefined && h && h.functionId >= 0) {
                            hypercallDataManager.registerRawHandler(h.functionId, decl.hypercallHandlerId);
                            Logger.log(LogCategory.SYSTEM,
                                `[HLE-shadow] ${descriptor.id}:${fm.name} promoted to WASM handler ` +
                                `${decl.hypercallHandlerId} (funcId ${h.functionId})`);
                        }
                    },
                    // Re-armed (active→shadowing): demote so calls flow through
                    // the JS shadow path again — WASM would serve them silently.
                    () => {
                        const h = this.patches.get(key);
                        if (h && h.functionId >= 0) hypercallDataManager.unregisterRawHandler(h.functionId);
                    },
                );
                handler = this.buildShadowHandler(runtime, decl, descriptor.id, fm.name, module.name, fm.address);
            }
            if (!handler) {
                Logger.warn(LogCategory.SYSTEM, `[HLE-lib] ${descriptor.id}: no handler for '${fm.name}' — skipping patch`);
                continue;
            }
            if (decl.entryFilter && decl.prologueLen === undefined) {
                Logger.error(LogCategory.SYSTEM,
                    `[HLE-lib] ${descriptor.id}:${fm.name} declares entryFilter but no prologueLen — ` +
                    `the filter's decline path (trampoline) is impossible; skipping hook`);
                continue;
            }
            const handle = applyPatch(patchCtx, {
                libId: descriptor.id,
                functionName: fm.name,
                moduleName: module.name,
                targetAddress: fm.address,
                callingConvention: decl.callingConvention,
                argCount: decl.argCount,
                handler,
                prologueLen: (needsTrampoline || decl.entryFilter) ? decl.prologueLen : undefined,
                entryFilter: decl.entryFilter,
            });
            if (handle) {
                this.patches.set(key, handle);
                if (needsTrampoline && handle.trampolineAddress === undefined) {
                    Logger.error(LogCategory.SYSTEM,
                        `[HLE-lib] ${descriptor.id}:${fm.name}: validateInGame hook patched without ` +
                        `trampoline — unpatching`);
                    this.unpatch(descriptor.id, fm.name, module.name);
                    continue;
                }
                if (runtime) this.shadowRuntimes.set(key, runtime);

                // Inner-loop WASM tier: bind the stub's functionId → the Rust
                // handler so the guest OUT is served in WASM; the JS handler
                // stays the fall-through. This is what turns a JS-tier regression
                // into a real speedup at kilo-calls/frame.
                //
                // NOT while in-game shadow validation is armed: the WASM handler
                // would serve the call and the JS shadow round-trip (which invokes
                // the original + compares) would never run. Promotion to WASM
                // happens on validation success (state→active, promoteToWasm).
                if (decl.hypercallHandlerId !== undefined && handle.functionId >= 0
                    && decl.shadow?.validateInGame !== true) {
                    hypercallDataManager.registerRawHandler(handle.functionId, decl.hypercallHandlerId);
                }

                Logger.log(LogCategory.SYSTEM,
                    `[HLE-lib] Patched ${descriptor.id}:${fm.name} at 0x${fm.address.toString(16)} ` +
                    `→ stub 0x${handle.stubAddress.toString(16)}` +
                    (decl.hypercallHandlerId !== undefined ? ` [WASM handler ${decl.hypercallHandlerId}]` : '') +
                    (handle.trampolineAddress !== undefined
                        ? ` (trampoline 0x${handle.trampolineAddress.toString(16)}, shadow n=${runtime?.targetCalls})`
                        : '') +
                    ` (module=${module.name})`);
            }
        }

        try {
            descriptor.onActivated?.(match);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `[HLE-lib] ${descriptor.id}.onActivated threw: ${e}`);
        }
    }

    /**
     * The wrapped ThunkImplementation for a shadow-enabled hook — the state
     * machine's dispatch surface (see shadow-validator.ts header for the
     * protocol). The ORIGINAL function is invoked through the trampoline via
     * the SYNCHRONOUS guest-call primitive (sync-guest-call.ts): the guest
     * runs to a sentinel inside this OUT trap and the hook returns a plain
     * sync value — no suspend, no scheduler involvement.
     */
    private buildShadowHandler(
        rt: ShadowHookRuntime,
        decl: HookedFunction,
        libId: string,
        fnName: string,
        moduleName: string,
        targetAddress: number,
    ): ThunkImplementation {
        const spec = decl.shadow!;
        const validateInGame = spec.validateInGame === true;
        const site = { moduleName, targetAddress };
        return (ctx, mem, args): ThunkResult | number => {
            libHleManager.countHit(libId, fnName);
            const liveView = new LiveShadowView(mem);
            let guardOk = true;
            if (spec.guard) {
                try { guardOk = spec.guard(args, liveView); } catch { guardOk = false; }
            }

            // ── Production path: kernel LIVE, direct sync-thunk return. Used
            //    unless the hook opts into the in-game trampoline round-trip.
            //    Correct for a pure leaf: byte-exact detection guarantees
            //    identity; the kernel's math is general, so a guard-fail (dims
            //    beyond the sane envelope, never seen in-game) still computes
            //    the right answer — we only log it. ──
            if (!validateInGame || rt.state === 'active' || rt.state === 'disabled') {
                if (rt.state === 'disabled') {
                    // The patch is already restored; hand the call to the real function
                    // instead of answering it. Fabricating a return is not survivable for
                    // an ABI whose contract includes a mutated state struct.
                    return this.completeViaRestoredOriginal(libId, fnName, moduleName, decl, targetAddress, args);
                }
                if (!guardOk) rt.recordGuardFail();
                try {
                    return { value: spec.kernel(liveView, args, site) >>> 0 };
                } catch (e) {
                    // A live kernel throw on a pure leaf means our ABI model is
                    // wrong — bail out to the guest permanently, and let the guest's own
                    // code produce this call's result.
                    rt.recordMismatch({ kind: 'kernel-threw', detail: String(e) });
                    this.unpatch(libId, fnName, moduleName);
                    return this.completeViaRestoredOriginal(libId, fnName, moduleName, decl, targetAddress, args);
                }
            }

            // ── Shadow validation path (opt-in): the ORIGINAL runs to
            //    completion synchronously via the trampoline and stays
            //    authoritative; the kernel runs against scratch; outputs are
            //    compared before the guest's own EAX goes back to the caller. ──
            const handle = this.resolvePatch(libId, fnName, moduleName);
            if (!handle || handle.trampolineAddress === undefined) {
                Logger.warn(LogCategory.SYSTEM, `[HLE-shadow] ${libId}:${fnName} called without trampoline — returning 0`);
                return 0;
            }
            // The dispatcher hands the handler a FIXED-SIZE args buffer (32
            // slots); only the first argCount are real. The sync call frame
            // must push exactly the real arity — the stdcall RET N cleans only
            // argCount*4.
            const callArgs = args.slice(0, decl.argCount);
            if (!guardOk) {
                rt.recordGuardFail();
                return this.completeViaOriginalSync(rt, spec, decl, handle, callArgs, liveView, site, null);
            }
            let ranges;
            let scratchView: ScratchShadowView;
            let kernelEax = 0;
            try {
                ranges = spec.ranges(callArgs, liveView);
                if (!rangesAreSane(ranges, mem.length)) {
                    rt.recordGuardFail();
                    return this.completeViaOriginalSync(rt, spec, decl, handle, callArgs, liveView, site, null);
                }
                scratchView = new ScratchShadowView(mem, ranges);
                kernelEax = spec.kernel(scratchView, callArgs, site) >>> 0;
                if (scratchView.outOfContractWrite) {
                    rt.recordMismatch({ kind: 'out-of-contract-write', detail: scratchView.outOfContractWrite });
                    return this.completeViaOriginalSync(rt, spec, decl, handle, callArgs, liveView, site, null);
                }
            } catch (e) {
                rt.recordMismatch({ kind: 'kernel-threw', detail: String(e) });
                return this.completeViaOriginalSync(rt, spec, decl, handle, callArgs, liveView, site, null);
            }
            const frozenRanges = ranges;
            return this.completeViaOriginalSync(rt, spec, decl, handle, callArgs, liveView, site, (guestEax) => {
                const mismatch = compareShadowOutputs(
                    mem, frozenRanges, scratchView.scratch, kernelEax, guestEax, spec.f32UlpTolerance);
                if (mismatch) rt.recordMismatch(mismatch);
                else rt.recordCleanCall();
            });
        };
    }

    /**
     * Complete the in-flight hooked call with the ORIGINAL function as the
     * authority, synchronously. `onReturn` (if any) sees the guest's EAX
     * before it is handed back to the real caller.
     *
     * If the sync run fails, the call is completed by the kernel running LIVE
     * (full output rewrite — also covers a partially-written dst after an
     * aborted original run): 'no-export' just demotes this hook to the
     * kernel-live production behavior (old wasm build, can't validate);
     * structural failures (thunk-entry / budget / hlt / esp-drift) mean the
     * callee is not the pure leaf the hook assumed → permanent unpatch.
     */
    private completeViaOriginalSync(
        rt: ShadowHookRuntime,
        spec: ShadowSpec,
        decl: HookedFunction,
        handle: PatchHandle,
        callArgs: number[],
        liveView: LiveShadowView,
        site: ShadowSite,
        onReturn: ((guestEax: number) => void) | null,
    ): ThunkResult | number {
        const res = this.runOriginalSync(decl, handle, callArgs);
        if (res.ok) {
            try { onReturn?.(res.eax); }
            catch (e) { Logger.error(LogCategory.SYSTEM, `[HLE-shadow] compare threw for ${handle.libId}:${handle.functionName}: ${e}`); }
            return { value: res.eax };
        }
        if (res.reason === 'no-export') {
            if (!this.warnedNoExport) {
                this.warnedNoExport = true;
                Logger.error(LogCategory.SYSTEM,
                    `[HLE-shadow] run_guest_until export missing (stale v86 wasm?) — ` +
                    `in-game validation impossible; hooks go kernel-live UNVALIDATED ` +
                    `(equivalent to validateInGame:false)`);
            }
            rt.state = 'active'; // kernel-live from here on (production behavior)
        } else {
            rt.recordMismatch({
                kind: 'sync-call-failed',
                detail: `original sync run failed: ${res.reason} — callee is not the assumed pure leaf`,
            });
        }
        try {
            return { value: spec.kernel(liveView, callArgs, site) >>> 0 };
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `[HLE-shadow] live-kernel completion threw for ${handle.libId}:${handle.functionName}: ${e}`);
            return 0;
        }
    }

    /**
     * Bail-out completion: run the RESTORED original at its OWN entry, synchronously, and
     * hand back its EAX and its side effects.
     *
     * The alternative — returning a fabricated 0 — is what the caller cannot survive: the
     * hooked functions here are not `int f(...)`, they return a pointer to a state struct the
     * call was also supposed to advance, so a bare 0 hands the caller NULL and an unchanged
     * count. Calling the target address (not the trampoline) is deliberate: by the time we
     * bail the patch bytes are gone, so the entry IS the original.
     */
    private completeViaRestoredOriginal(
        libId: string,
        fnName: string,
        moduleName: string,
        decl: HookedFunction,
        targetAddress: number,
        args: number[],
    ): ThunkResult | number {
        if (this.resolvePatch(libId, fnName, moduleName)) {
            Logger.error(LogCategory.SYSTEM,
                `[HLE-lib] ${libId}:${fnName} (${moduleName}): bail-out with the patch still installed — ` +
                `re-entering would loop; returning 0`);
            return 0;
        }
        const env = this.syncEnv();
        if (env) {
            const effEnv = decl.shadow?.allowGuestImports ? { ...env, abortLo: 0, abortHi: 0 } : env;
            const res = callGuestFunctionSync(effEnv, targetAddress, args.slice(0, decl.argCount), decl.callingConvention);
            if (res.ok) return { value: res.eax >>> 0 };
            Logger.error(LogCategory.SYSTEM,
                `[HLE-lib] ${libId}:${fnName} (${moduleName}): could not run the restored original ` +
                `(${res.reason}) — the caller gets 0 and no side effects`);
            return 0;
        }
        Logger.error(LogCategory.SYSTEM,
            `[HLE-lib] ${libId}:${fnName} (${moduleName}): no sync-call environment for the bail-out — ` +
            `the caller gets 0 and no side effects`);
        return 0;
    }

    /** Run the hook's ORIGINAL function via its trampoline, synchronously. */
    private runOriginalSync(decl: HookedFunction, handle: PatchHandle, callArgs: number[]): SyncCallResult {
        const env = this.syncEnv();
        if (!env) return { ok: false, reason: 'no-export' };
        const effEnv = decl.shadow?.allowGuestImports ? { ...env, abortLo: 0, abortHi: 0 } : env;
        return callGuestFunctionSync(effEnv, handle.trampolineAddress!, callArgs, decl.callingConvention);
    }

    /** Assemble the sync-call environment (lazy sentinel, live wasm export). */
    private syncEnv(): SyncCallEnv | null {
        if (!this.init) return null;
        const cpu = this.init.getCpu();
        const mem = this.init.getMemory();
        if (!cpu || !mem) return null;
        if (this.sentinelAddress === 0) {
            this.sentinelAddress = this.init.thunkGenerator.allocateRawCodeArea(16);
            writeSentinelBytes(mem, this.sentinelAddress);
        }
        const ex = preemptionManager.getWasmExports?.();
        const scheduler = System.getInstance().scheduler;
        return {
            cpu,
            mem,
            runGuestUntil: ex?.run_guest_until,
            sentinelAddress: this.sentinelAddress,
            // Whole thunk/callback/spin bucket: EIP re-entering it mid-run
            // means the callee tried to call a WinAPI import (the trampoline
            // itself is exempted by address inside run_guest_until).
            abortLo: MEM_THUNK_CODE_BASE,
            abortHi: MEM_ROM_BASE,
            pin: () => scheduler.pinCurrentThread(),
            unpin: () => scheduler.unpinCurrentThread(),
        };
    }

    /** Shadow status table (dbg.hleHooks / harness). */
    getShadowStatuses(): ShadowHookStatus[] {
        return Array.from(this.shadowRuntimes.values()).map(rt => rt.status());
    }

    /**
     * Re-arm shadow validation (dbg.hleShadow). Without arguments re-arms every
     * non-disabled hook; with libId/fnName only that hook. Returns re-armed count.
     */
    rearmShadow(libId?: string, fnName?: string, n?: number): number {
        let count = 0;
        for (const [key, rt] of this.shadowRuntimes) {
            const [keyLib, , keyFn] = key.split('|');
            if (libId && keyLib !== libId) continue;
            if (fnName && keyFn !== fnName) continue;
            if (rt.rearm(n)) count++;
        }
        return count;
    }

    /**
     * Runtime safety net: restore a patched function's original bytes so
     * subsequent calls execute guest code instead of our handler. Used when
     * a handler detects that its assumptions are wrong (false-positive
     * detection, unsupported library version) and staying hooked would
     * crash the game. Idempotent — a no-op for functions that aren't
     * patched.
     */
    unpatch(libId: string, functionName: string, moduleName?: string): boolean {
        const handle = this.resolvePatch(libId, functionName, moduleName);
        if (!handle) return false;
        const mem = this.init?.getMemory() ?? null;
        if (!mem) {
            Logger.warn(LogCategory.SYSTEM, `[HLE-lib] unpatch: guest memory unavailable for ${libId}:${functionName}`);
            return false;
        }
        if (!writeGuestCode(mem, handle.originalBytes, handle.targetAddress)) {
            Logger.error(LogCategory.SYSTEM,
                `[HLE-lib] unpatch: restoring ${libId}:${functionName} at ` +
                `0x${handle.targetAddress.toString(16)} overran guest memory — patch still live`);
            return false;
        }
        // Drop the WASM dispatch binding too, so a bailed-out hook stops being
        // served in WASM (the original guest bytes are back — no stub to reach).
        if (handle.functionId >= 0) {
            hypercallDataManager.unregisterRawHandler(handle.functionId);
        }
        this.patches.delete(LibHleManager.patchKey(libId, handle.moduleName, functionName));
        Logger.log(LogCategory.SYSTEM,
            `[HLE-lib] Unpatched ${libId}:${functionName} (${handle.moduleName}) at ` +
            `0x${handle.targetAddress.toString(16)} — restored ${handle.originalBytes.length} original bytes`,
        );
        return true;
    }

    /** Unpatch every function under a libId, in every module carrying it. */
    unpatchAll(libId: string): number {
        const targets = Array.from(this.patches.values()).filter(h => h.libId === libId);
        let count = 0;
        for (const h of targets) {
            if (this.unpatch(libId, h.functionName, h.moduleName)) count++;
        }
        return count;
    }

    /** Called from handlers to increment a per-function hit counter. */
    countHit(libId: string, functionName: string): void {
        let libHits = this.hits.get(libId);
        if (!libHits) { libHits = new Map(); this.hits.set(libId, libHits); }
        libHits.set(functionName, (libHits.get(functionName) ?? 0) + 1);
    }

    /** Drop patch bookkeeping after guest memory is torn down (game switch). */
    resetOnGameSwitch(): void {
        this.matches.clear();
        this.patches.clear();
        this.hits.clear();
        this.shadowRuntimes.clear();
        this.sentinelAddress = 0; // thunk region is rebuilt with the process
        this.warnedNoExport = false;
        // Descriptors hold per-site state resolved out of the old image (table addresses,
        // constants) — keyed by guest address, so it must not outlive that address space.
        for (const desc of libRegistry.getAll()) {
            try { desc.onReset?.(); } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `[HLE-lib] ${desc.id}.onReset threw: ${e}`);
            }
        }
        // Guest-RAM handler configs died with the process — clear the page
        // pointers so a WASM handler can't read a stale block in fresh memory.
        hypercallDataManager.setEaglTokenConfigPtr(0);
    }

    /** Snapshot for console/diagnostics. */
    getReport(): HleReportEntry[] {
        const entries: HleReportEntry[] = [];
        for (const [libId, byModule] of this.matches) {
            for (const [moduleName, match] of byModule) {
                const libHits = this.hits.get(libId);
                const patchRows = Array.from(this.patches.values())
                    .filter(p => p.libId === libId && p.moduleName === moduleName)
                    .map(p => ({
                        name: p.functionName,
                        addr: '0x' + p.targetAddress.toString(16),
                        hits: libHits?.get(p.functionName) ?? 0,
                    }));
                entries.push({
                    lib: libId,
                    confidence: match.confidence,
                    module: moduleName,
                    patches: patchRows,
                    missing: match.missingFunctions,
                });
            }
        }
        return entries;
    }

    dumpReport(): void {
        const rows = this.getReport();
        if (rows.length === 0) {
            Logger.log(LogCategory.SYSTEM, `[HLE-lib] No library matches recorded`);
            return;
        }
        for (const r of rows) {
            Logger.log(LogCategory.SYSTEM,
                `[HLE-lib] ${r.lib} @ ${r.module} (confidence=${r.confidence}, patches=${r.patches.length}` +
                (r.missing.length > 0 ? `, missing=${r.missing.join(',')}` : '') + `)`);
            for (const p of r.patches) {
                Logger.log(LogCategory.SYSTEM, `           ${p.name}  target=${p.addr}  hits=${p.hits}`);
            }
        }
    }
}

export const libHleManager = new LibHleManager();

/** Convenience for handlers: bumps a hit counter without needing a manager import. */
export function recordHleHit(libId: string, functionName: string): void {
    libHleManager.countHit(libId, functionName);
    // Silence unused import in strict configs by keeping a defensive guard.
    void System;
}
