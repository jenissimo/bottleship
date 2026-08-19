/**
 * Breakpoints & execution control. Three address-breakpoint kinds —
 * don't conflate them: raw EIP, export (moduleRegistry.getExportAddress), and
 * symbol (sidecar map). Plus API breakpoints (JS layer, NO JIT-off) and memory
 * watches. Awaitable: each blocking break resolves on first hit with a
 * fault-grade snapshot, or stays continuous and streams events.
 *
 * Hard constraint (documented loudly): EIP/export/symbol/watch breakpoints
 * require JIT OFF — breakOn auto-calls dbg.enable() and warns that perf
 * collapses while armed. API breakpoints do NOT need JIT off → prefer them for
 * bring-up. Addresses inside the async-park spin loop are refused.
 *
 * SECOND hard constraint, and the one that produces silent zeroes: an EIP breakpoint
 * only fires when the address is a v86 BLOCK ENTRY (the wasm hook runs once per block,
 * and blocks end at call/ret/out/far or page-crossing flow, not at jmp/jcc). A bp on a
 * mid-function instruction never fires however often the code runs — with JIT off just
 * the same as with `fast:true`. Arm the function ENTRY (breakOnExport/breakOnSymbol do
 * this by construction) and use trapWrites for "who writes this address".
 */

import type { HarnessService, HarnessCtx } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys, proc } from "../serialize";
import { dbg } from "../../core/debug/dbg-commands";
import { apiBreaks } from "../api-breaks";
import { eipBreaks, type BreakWhen, type BreakCapture } from "../eip-breaks";
import { symbolMap } from "../symbol-map";

function toAddr(x: number | string): number {
    if (typeof x === "number") return x >>> 0;
    const s = String(x).trim();
    return (s.startsWith("0x") || s.startsWith("0X") ? parseInt(s.slice(2), 16) : parseInt(s, 16)) >>> 0;
}

/** Refuse EIP breakpoints inside the async-park spin loop. */
function assertNotSpinLoop(addr: number): void {
    const sched: any = sys().scheduler as any;
    const base = (sched?.spinLoopBase ?? 0) >>> 0;
    const end = (sched?.spinLoopEnd ?? 0) >>> 0;
    if (base > 0 && end > base && addr >= base && addr < end) {
        throw new HarnessError(`0x${addr.toString(16)} is inside the async-park spin loop [0x${base.toString(16)}..0x${end.toString(16)}) — refusing`, HarnessErrorCode.BAD_ARGS);
    }
}

/** Arm an awaitable EIP breakpoint (auto JIT-off). Resolves on hit, or returns
 *  immediately when continuous. */
function armEip(addr: number, ctx: HarnessCtx, opts: { continuous?: boolean; pause?: boolean; when?: BreakWhen; capture?: BreakCapture; fast?: boolean }, extra: Record<string, unknown>): Promise<unknown> {
    assertNotSpinLoop(addr);
    let warning: string;
    if (opts.fast) {
        // Keep JIT ON; the cpu.rs page-gate keeps ONLY the bp's page interpreted. Lets a bp fire
        // deep in a long boot at full speed (no global JIT-off crawl). Requires the v86 build with
        // page_contains_bp (public/v86.wasm).
        dbg.bpFast(addr);
        warning = "FAST bp: JIT stays ON, only the bp's 4KiB page is interpreted (page-gate). Near-full speed.";
    } else {
        dbg.enable();        // JIT OFF (required) — perf collapses while armed
        dbg.bp(addr);        // arm the wasm interpreter breakpoint (persists across reloads via cfg)
        warning = "JIT is OFF while this breakpoint is armed — emulator perf collapses. clearBreaks() to restore.";
    }
    warning += " BLOCK ENTRIES ONLY: this fires only if the address is where v86 starts a block " +
        "(function entry / after a call or ret). A mid-function instruction NEVER fires even while the " +
        "code runs — 0 hits is not evidence it did not execute. For 'who writes X', use trapWrites.";
    return new Promise((resolve) => {
        const id = eipBreaks.arm(addr, {
            runId: ctx.runId,
            once: !opts.continuous,
            pause: opts.pause !== false,
            when: opts.when,
            capture: opts.capture,
            onHit: opts.continuous ? undefined : (snap) => resolve({ hit: snap, addr: addr >>> 0, warning, ...extra }),
        });
        if (opts.continuous) resolve({ armed: true, id, addr: addr >>> 0, continuous: true, warning, ...extra });
        ctx.signal.addEventListener("abort", () => eipBreaks.disarm(id), { once: true });
    });
}

export function registerBreakpointCommands(svc: HarnessService): void {
    /** breakOn(eip, opts) — raw linear EIP. */
    svc.register("breakOn", (args, ctx) => {
        const addr = toAddr(args[0] as number | string);
        return armEip(addr, ctx, (args[1] ?? {}) as any, { kind: "eip" });
    });

    /** breakOnExport('d3d9.dll!Direct3DCreate9') — resolve via the export table. */
    svc.register("breakOnExport", (args, ctx) => {
        const name = String(args[0] ?? "");
        const bang = name.indexOf("!");
        if (bang < 0) throw new HarnessError("breakOnExport expects 'module!Export'", HarnessErrorCode.BAD_ARGS);
        const mod = name.slice(0, bang).replace(/\.dll$/i, "");
        const exp = name.slice(bang + 1);
        const mr: any = proc()?.moduleRegistry as any;
        const addr = mr?.getExportAddress?.(mod, exp);
        if (addr === undefined) throw new HarnessError(`export ${mod}!${exp} not found (module loaded yet?)`, HarnessErrorCode.NOT_FOUND);
        return armEip(addr >>> 0, ctx, (args[1] ?? {}) as any, { kind: "export", export: name, addr: addr >>> 0 });
    });

    /** breakOnSymbol('core!UInput::ReadInput') — resolve via the sidecar map. */
    svc.register("breakOnSymbol", (args, ctx) => {
        const name = String(args[0] ?? "");
        const addr = symbolMap.resolve(name);
        if (addr === undefined) throw new HarnessError(`symbol '${name}' not in any loaded symbol map (loadSymbols first)`, HarnessErrorCode.NOT_FOUND);
        return armEip(addr, ctx, (args[1] ?? {}) as any, { kind: "symbol", symbol: name });
    });

    /** breakOnApi('d3d9.*' | '*DrawPrimitive*' | 'Direct3DCreate9') — JS layer, no JIT off.
     *  `argEq: {index, value}` narrows to one call among many (`breakOnApi('user32:LoadStringA',
     *  {argEq:{index:1, value:137}})` catches the one interesting string id out of 400). */
    svc.register("breakOnApi", (args, ctx) => {
        const pattern = String(args[0] ?? "");
        if (!pattern) throw new HarnessError("breakOnApi expects a pattern", HarnessErrorCode.BAD_ARGS);
        const opts = (args[1] ?? {}) as { continuous?: boolean; argEq?: { index: number; value: number } };
        if (opts.argEq && (typeof opts.argEq.index !== "number" || typeof opts.argEq.value !== "number")) {
            throw new HarnessError("breakOnApi argEq expects {index:number, value:number}", HarnessErrorCode.BAD_ARGS);
        }
        return new Promise((resolve) => {
            const id = apiBreaks.arm(pattern, {
                runId: ctx.runId,
                continuous: !!opts.continuous,
                argEq: opts.argEq,
                onHit: opts.continuous ? undefined : (snap) => resolve({ hit: snap, pattern }),
            });
            if (opts.continuous) resolve({ armed: true, id, pattern, continuous: true });
            ctx.signal.addEventListener("abort", () => apiBreaks.disarm(id), { once: true });
        });
    });

    /** watchMem(addr, {indirect?}) — arm a wasm memory watch (value logged in [DBG]
     *  traces; observe via streamLogs). Requires JIT off. */
    svc.register("watchMem", (args) => {
        const addr = toAddr(args[0] as number | string);
        const opts = (args[1] ?? {}) as { indirect?: boolean };
        dbg.enable();
        dbg.watch(addr, !!opts.indirect);
        return { armed: true, addr, note: "watched value appears in [DBG] traces — use streamLogs(['SYSTEM']) to observe; JIT is OFF" };
    });

    /** headWatch(headAddr, loEip, hiEip) — TEMP crash-hunt: snapshot a guest list head
     *  across context switches, log switch-outs mid-mutation and torn (0) states.
     *  JIT stays ON (deterministic-preserving). headWatch(0) disarms. */
    svc.register("headWatch", (args) => {
        const headAddr = toAddr(args[0] as number | string);
        const loEip = args[1] != null ? toAddr(args[1] as number | string) : 0;
        const hiEip = args[2] != null ? toAddr(args[2] as number | string) : 0;
        const sched: any = sys().scheduler as any;
        if (typeof sched?.setDebugHeadWatch !== "function") throw new HarnessError("scheduler.setDebugHeadWatch unavailable", HarnessErrorCode.BAD_ARGS);
        sched.setDebugHeadWatch(headAddr, loEip, hiEip);
        const disp: any = proc()?.dispatcher as any;   // also sample this dword per-hypercall (report.lastHypercalls)
        if (disp) {
            disp.hcWatchAddr = headAddr >>> 0;
            disp.hcRingEnabled = !!headAddr;            // arm/disarm the hot-path hypercall ring with the watch
        }
        return { armed: !!headAddr, headAddr, loEip, hiEip, note: "events captured to scheduler ring — read with `headWatchDump`; head sampled per-hypercall in report.lastHypercalls" };
    });

    /** xlate(vaddr) — compare physical (identity) read vs CPU paged translation of a guest
     *  linear address. If pa !== va (non-identity) or paVal !== physVal, the CPU sees a
     *  different physical page than identity — a paging/CoW view inconsistency. */
    svc.register("xlate", (args) => {
        const va = toAddr(args[0] as number | string) >>> 0;
        const p: any = proc();
        const cpu: any = p?.v86?.cpu ?? p?.v86?.v86?.cpu;
        if (!cpu) throw new HarnessError("no cpu", HarnessErrorCode.BAD_ARGS);
        const dv: DataView = new DataView(cpu.mem8.buffer);
        const physVal = dv.getUint32(va, true) >>> 0;
        let pa = -1, paVal = -1, err: string | null = null;
        try { pa = cpu.translate_address_system_read(va) >>> 0; paVal = dv.getUint32(pa, true) >>> 0; }
        catch (e) { err = String(e); }
        const cr0 = (cpu.cr?.[0] ?? 0) >>> 0, cr3 = (cpu.cr?.[3] ?? 0) >>> 0;
        const h = (n: number) => "0x" + (n >>> 0).toString(16);
        return {
            va: h(va), physVal: h(physVal), pa: pa < 0 ? null : h(pa), paVal: paVal < 0 ? null : h(paVal),
            identity: pa === va, viewMismatch: pa >= 0 && paVal !== physVal,
            cr0: h(cr0), cr3: h(cr3), paging: !!(cr0 & 0x80000000), err,
        };
    });

    /** headWatchDump() — return captured headWatch events (survives the crash).
     *  `zeroFlips` = per-tick snapshots of the list head flipping to/from 0 (the writer). */
    svc.register("headWatchDump", () => {
        const sched: any = sys().scheduler as any;
        const log: string[] = typeof sched?.getDebugHeadWatchLog === "function" ? sched.getDebugHeadWatchLog() : [];
        const zeros: string[] = typeof sched?.getDebugHeadZeroSnaps === "function" ? sched.getDebugHeadZeroSnaps() : [];
        return { count: log.length, events: log, zeroFlips: zeros };
    });

    /** step(n) — arm an interpreter trace of the next N instructions (-> [DBG] log). */
    svc.register("step", (args) => {
        const n = Math.max(1, Number(args[0] ?? 1) | 0);
        dbg.enable();
        dbg.step(n);
        return { armed: n, note: "instruction trace appears in [DBG] traces (console.error) — observe via streamLogs" };
    });

    /** loadSymbols(module, {name:rva,...}) — install a sidecar symbol map for breakOnSymbol. */
    svc.register("loadSymbols", (args) => {
        const mod = String(args[0] ?? "");
        const entries = (args[1] ?? {}) as Record<string, number>;
        const n = symbolMap.load(mod, entries);
        return { module: mod, symbols: n };
    });

    /** pause() / resume() — stop/run the guest loop via the canonical path (sets the
     *  module-level isPaused; a bare v86.stop() is undone by the 1ms scheduler). */
    svc.register("pause", () => {
        if (!proc()?.v86) throw new HarnessError("no v86 instance", HarnessErrorCode.NO_PROCESS);
        const fn = (globalThis as any).__harnessPause;
        if (!fn) throw new HarnessError("pause hook not installed", HarnessErrorCode.UNSUPPORTED);
        fn();
        return { paused: true };
    });
    svc.register("resume", () => {
        if (!proc()?.v86) throw new HarnessError("no v86 instance", HarnessErrorCode.NO_PROCESS);
        const fn = (globalThis as any).__harnessResume;
        if (!fn) throw new HarnessError("resume hook not installed", HarnessErrorCode.UNSUPPORTED);
        fn();
        return { paused: false };
    });

    /** captureAt(eip, specs, label?) — non-pausing EIP breakpoint that records register-relative
     *  memory into globalThis.__bpcap on every hit (read via worker-eval). Sidesteps the
     *  pause-wedge: JIT is OFF (eip bp) but the guest keeps running. Each spec:
     *  { reg:'edi', off?:0, count?:1, deref?:false, sample?:0 } — base=reg+off; ptr=deref?*(base):base;
     *  reads `count` dwords at ptr; if `sample`>0, counts non-zero bytes in [ptr, ptr+sample). */
    svc.register("captureAt", (args, ctx) => {
        const addr = toAddr(args[0] as number | string);
        assertNotSpinLoop(addr);
        interface CapSpec { reg: string; off?: number; count?: number; deref?: boolean; sample?: number; postOff?: number; eq?: number; ne?: number; ge?: number; lt?: number; path?: number[] }
        const specs = (args[1] ?? []) as CapSpec[];
        const label = String(args[2] ?? "cap");
        const RI: Record<string, number> = { eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7 };
        dbg.enable(); dbg.bp(addr);
        dbg.maxDumps(1_000_000);   // hot-address captures blow the 4000-line default silently
        const g = globalThis as any;
        const id = eipBreaks.arm(addr, {
            runId: ctx.runId, once: false, pause: false,
            onHit: () => {
                try {
                    const c: any = proc()?.v86?.cpu ?? (proc() as any)?.v86?.v86?.cpu;
                    const m: Uint8Array | undefined = (proc() as any)?.getCurrentMemory?.();
                    if (!c?.reg32 || !m) return;
                    const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
                    const rU = (a: number) => (a >>> 0) + 4 <= m.length ? dv.getUint32(a >>> 0, true) >>> 0 : -1;
                    const rec: any = { label, seq: (g.__seq = (g.__seq || 0) + 1) };
                    for (const s of specs) {
                        // Address resolution: `path` walks a deref chain (cur = *(cur+p) per hop);
                        // legacy form is reg+off with one optional deref. postOff shifts the final ptr.
                        let ptr: number;
                        let key: string;
                        if (s.path && s.path.length) {
                            let cur = c.reg32[RI[s.reg]] >>> 0;
                            for (const p of s.path) cur = rU((cur + (p | 0)) >>> 0) >>> 0;
                            ptr = (cur + ((s.postOff ?? 0) | 0)) >>> 0;
                            key = s.reg + "[" + s.path.join(",") + "]+" + ((s.postOff ?? 0) | 0);
                        } else {
                            const base = ((c.reg32[RI[s.reg]] >>> 0) + ((s.off ?? 0) | 0)) >>> 0;
                            ptr = (((s.deref ? rU(base) : base) >>> 0) + ((s.postOff ?? 0) | 0)) >>> 0;
                            key = s.reg + "+" + ((s.off ?? 0) | 0) + (s.deref ? "*" : "") + "+" + ((s.postOff ?? 0) | 0);
                        }
                        // eq/ne/ge/lt on a spec make it a FILTER: value at ptr must match or the whole hit is dropped.
                        if (s.eq !== undefined || s.ne !== undefined || s.ge !== undefined || s.lt !== undefined) {
                            const v = rU(ptr) >>> 0;
                            if (s.eq !== undefined && v !== (s.eq >>> 0)) return;
                            if (s.ne !== undefined && v === (s.ne >>> 0)) return;
                            if (s.ge !== undefined && v < (s.ge >>> 0)) return;
                            if (s.lt !== undefined && v >= (s.lt >>> 0)) return;
                        }
                        const vals: string[] = [];
                        for (let k = 0; k < (s.count ?? 1); k++) vals.push("0x" + (rU((ptr + k * 4) >>> 0) >>> 0).toString(16));
                        let nz: number | null = null;
                        if (s.sample && ptr > 0x1000 && (ptr + s.sample) < m.length) { nz = 0; for (let i = 0; i < s.sample; i++) if (m[(ptr + i) >>> 0]) nz++; }
                        rec[key] = { ptr: "0x" + (ptr >>> 0).toString(16), vals, nz };
                    }
                    (g.__bpcap ??= []).push(rec);
                    if (g.__bpcap.length > 6000) g.__bpcap.shift();
                } catch { /* */ }
            },
        });
        return { armed: true, id, addr: addr >>> 0, note: "records to globalThis.__bpcap (JIT off, non-pausing)" };
    });

    /** breaks() — list all armed breakpoints. */
    svc.register("breaks", () => {
        const eip = eipBreaks.list();
        return {
            api: apiBreaks.list(),
            eip: eip.map((e) => (e.hits === 0
                ? { ...e, note: "0 hits — an EIP bp only fires at a v86 BLOCK ENTRY, so this may mean 'not a block entry', not 'never executed'" }
                : e)),
            symbolMaps: symbolMap.loaded(),
        };
    });

    /** clearBreaks() — disarm everything (and restore JIT via dbg.clear()). */
    svc.register("clearBreaks", () => {
        const api = apiBreaks.clear();
        const eip = eipBreaks.clear();
        dbg.clear();
        return { clearedApi: api, clearedEip: eip, note: "wasm bps/watches cleared; JIT stays off until reload (dbg.jitOn() to re-enable)" };
    });
}
