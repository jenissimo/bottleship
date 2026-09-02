/**
 * dbg — generic RPC bridge to the worker's dbg command table (dbg-commands.ts),
 * with the return value delivered over harness_rpc instead of console.log.
 *
 * The legacy `{type:'dbg'}` channel is fire-and-forget: results go to the log
 * firehose and an agent has to grep them back out. `dbgCall` invokes the same
 * functions and returns whatever they return (dispatchStats' counter object,
 * jitcfg's void, ...) as the step result — so measurement-gate runs
 * (d3d9Perf / dispatchStats / trace2PageHistogram A/Bs) read as plain POJOs
 * from a harness chain: `.call("dbgCall", "dispatchStats")`.
 *
 * Functions that only console.log their JSON (e.g. d3d9Perf) still do; their
 * return value (if any) rides the RPC reply.
 */

import type { HarnessService } from "../service";
import { dbg } from "../../core/debug/dbg-commands";
import { System } from "../../core/system";
import { getSehUnwindTrace } from "../../core/seh-dispatch";
import { guestCodeInvalidationStats, takeGuestCodeAuditPages } from "../../core/memory/guest-code";
import { localeFastPathStats } from "../../modules/kernel32/locale";
import { d3d9RefcountStorageStats } from "../../modules/d3d9/com-refs";
import { d3d9GuestAddRefStats } from "../../modules/d3d9/guest-addref-stub";
import { d3d9StateBlockShadowStats } from "../../modules/d3d9/state-block-shadow-window";
import { d3d9GuestReleaseStats } from "../../modules/d3d9/guest-release-stub";
import { d3d9PipelineMemoProfileStats, d3d9PipelineMemoStats } from "../../backends/webgpu/d3d9/d3d9-pipeline-memo";
import type { RegionKind } from "../../core/memory/address-space";

/** Names applied through either flag door — this RPC and emulator.worker.ts's
 *  `set_debug_flag` — so resetWorkerFlags clears exactly those and never a same-shaped
 *  global the worker installed itself. */
const APPLIED_WORKER_FLAGS = "__appliedWorkerFlags";

export function noteAppliedWorkerFlag(name: string): void {
    const g = globalThis as Record<string, unknown>;
    ((g[APPLIED_WORKER_FLAGS] ??= new Set<string>()) as Set<string>).add(name);
}

/** Decode a generated thunk stub (`B8 <id32> BA 77 B0 00 00 EF C2 <cleanup16>`). */
function decodeStub(mem: Uint8Array, addr: number, names: Record<number, string> | undefined) {
    if (addr < 0 || addr + 12 > mem.length) return { valid: false as const, reason: "out of range" };
    if (mem[addr] !== 0xB8) return { valid: false as const, reason: `not a stub (byte 0x${mem[addr].toString(16)})` };
    const functionId = (mem[addr + 1] | (mem[addr + 2] << 8) | (mem[addr + 3] << 16) | (mem[addr + 4] << 24)) >>> 0;
    const cleanup = mem[addr + 9] === 0xC2 ? (mem[addr + 10] | (mem[addr + 11] << 8)) : 0;
    return { valid: true as const, functionId, name: names?.[functionId] ?? null, cleanup };
}

/** Per-page hashes from the previous codeAudit sweep (page number → FNV-1a of its 4 KiB). */
const auditHashes = new Map<number, number>();

/**
 * `[start,end)` of every IMAGE_SCN_MEM_EXECUTE section of the PE mapped at `base`, parsed
 * out of the headers as the guest sees them. Returns null when `base` is not a mapped image.
 */
function peExecutableSections(mem: Uint8Array, base: number): Array<[number, number]> | null {
    const u16 = (a: number) => mem[a]! | (mem[a + 1]! << 8);
    const u32 = (a: number) => (mem[a]! | (mem[a + 1]! << 8) | (mem[a + 2]! << 16) | (mem[a + 3]! << 24)) >>> 0;
    if (base + 0x40 > mem.length || u16(base) !== 0x5a4d) return null;      // 'MZ'
    const pe = base + u32(base + 0x3c);
    if (pe + 0x18 > mem.length || u32(pe) !== 0x00004550) return null;      // 'PE\0\0'
    const nSections = u16(pe + 6);
    const optSize = u16(pe + 20);
    let sec = pe + 24 + optSize;
    const out: Array<[number, number]> = [];
    for (let i = 0; i < nSections && sec + 40 <= mem.length; i++, sec += 40) {
        if ((u32(sec + 36) & 0x20000000) === 0) continue;                   // MEM_EXECUTE
        const va = base + u32(sec + 12);
        const size = Math.max(u32(sec + 8), u32(sec + 16));                 // virtual, else raw
        if (size > 0) out.push([va, va + size]);
    }
    return out.length > 0 ? out : null;
}

export function registerDbgCommands(svc: HarnessService): void {
    /**
     * sehTrace({clear}) — the RtlUnwind frame-by-frame decision log: for each unwind,
     * the chain head, the target frame, and for every frame in between its handler,
     * how it was classified and therefore whether its handler ran. A runtime that is
     * not MSVC (LuaJIT, a custom VM) does its teardown ONLY on that pass, so a frame
     * skipped here is a runtime left half-unwound — a corruption that surfaces much
     * later and nowhere near the unwind. Not derivable from the log stream: the
     * per-frame lines are VERBOSE and the socket drops them under load.
     */
    svc.register("sehTrace", (...args: unknown[]) => ({
        lines: getSehUnwindTrace((args[0] as { clear?: boolean } | undefined)?.clear === true),
    }));

    /**
     * comVtable(module, iface?) — dump a module's COM vtables slot by slot, resolving each
     * slot to the thunk it points at.
     *
     * A vtable is allocated with exactly as many dwords as its InterfaceDescriptor declares
     * and sits flush against generated stub code, so a guest call to a slot we under-declared
     * reads raw x86 as a function pointer and jumps into hyperspace. That failure only shows up
     * as an unrelatable wild EIP, so `unresolvedSlots` — any slot whose target does not decode
     * as a stub — is the field worth reading first.
     */
    svc.register("comVtable", (args) => {
        const [moduleName, iface] = args as [string, string | undefined];
        const process = System.getInstance().process;
        const mod = process?.getModule?.(moduleName) as { vtables?: Record<string, { address: number; size: number }> } | undefined;
        const vtables = mod?.vtables;
        if (!vtables) throw new Error(`comVtable: module '${moduleName}' has no vtables`);

        const mem = process!.getCurrentMemory();
        const names = (process!.dispatcher as unknown as { namesTable?: Record<number, string> })?.namesTable;
        const wanted = iface ? [iface] : Object.keys(vtables);

        const out = wanted.map((name) => {
            const vt = vtables[name];
            if (!vt) return { interface: name, error: "no such vtable", known: Object.keys(vtables) };
            const slots = [];
            for (let i = 0; i < vt.size; i++) {
                const target = ((mem[vt.address + i * 4]) | (mem[vt.address + i * 4 + 1] << 8)
                    | (mem[vt.address + i * 4 + 2] << 16) | (mem[vt.address + i * 4 + 3] << 24)) >>> 0;
                slots.push({ index: i, target: `0x${target.toString(16)}`, ...decodeStub(mem, target, names) });
            }
            return {
                interface: name,
                address: `0x${vt.address.toString(16)}`,
                slotCount: vt.size,
                unresolvedSlots: slots.filter((s) => !s.valid).map((s) => s.index),
                slots,
            };
        });

        return iface ? out[0] : out;
    });

    /**
     * codeInvalidations() — is the guest-code JIT-invalidation path actually wired, and
     * how much has it dropped?
     *
     * v86 cannot see a JS write, so every JS publication of guest-executable bytes must
     * call jit_dirty_cache or the CPU keeps running the block it compiled from the old
     * bytes (wrong thunk dispatched / ESP drift / wild ret). `wired:false` or a flat
     * `ranges` while stubs are being published means the invariant is silently off —
     * check that BEFORE theorising about the guest.
     */
    svc.register("codeInvalidations", () => guestCodeInvalidationStats());

    /** localeFastPath({reset?}) — MultiByteToWideChar fast-path hit/bail census. A fast path
     *  that never fires is indistinguishable from an expensive thunk in any profile, so
     *  `mbtwcSlow` with a `bail` reason (and `lastCodePage`) is what says which one you have.
     *  Flow: localeFastPath({reset:true}) -> exercise the game -> localeFastPath(). */
    svc.register("localeFastPath", (args) => {
        const opts = (args[0] ?? {}) as { reset?: boolean; callers?: boolean };
        if (opts.callers === true && localeFastPathStats.callerCensus === null) {
            localeFastPathStats.callerCensus = new Map();
        } else if (opts.callers === false) {
            localeFastPathStats.callerCensus = null;
        }
        const census = localeFastPathStats.callerCensus;
        const snapshot = {
            mbtwcFast: localeFastPathStats.mbtwcFast,
            mbtwcSlow: localeFastPathStats.mbtwcSlow,
            mbtwcThunk: localeFastPathStats.mbtwcThunk,
            mbtwcUnbound: localeFastPathStats.mbtwcThunk - localeFastPathStats.mbtwcSlow,
            bail: { ...localeFastPathStats.mbtwcBail },
            lastCodePage: localeFastPathStats.lastCodePage,
            wctmbFast: localeFastPathStats.wctmbFast,
            wctmbBail: { ...localeFastPathStats.wctmbBail },
            lcmapFast: localeFastPathStats.lcmapFast,
            lcmapDeclined: localeFastPathStats.lcmapDeclined,
            lcmapBail: { ...localeFastPathStats.lcmapBail },
            glinfoCalls: localeFastPathStats.glinfoCalls,
            glinfoTypes: [...localeFastPathStats.glinfoTypes.entries()]
                .sort((a, b) => b[1] - a[1]).slice(0, 12)
                .map(([t, n]) => ({ lcType: `0x${t.toString(16)}`, calls: n })),
            lcmapFlags: [...localeFastPathStats.lcmapFlags.entries()]
                .sort((a, b) => b[1] - a[1]).slice(0, 8)
                .map(([f, n]) => ({ flags: `0x${f.toString(16)}`, calls: n })),
            mbtwcChars: localeFastPathStats.mbtwcChars,
            mbtwcMaxChars: localeFastPathStats.mbtwcMaxChars,
            mbtwcTruncated: localeFastPathStats.mbtwcTruncated,
            mbtwcAvgChars: localeFastPathStats.mbtwcFast > 0
                ? Math.round(localeFastPathStats.mbtwcChars / localeFastPathStats.mbtwcFast * 10) / 10 : 0,
            mbtwcLenHist: { "<=8": localeFastPathStats.mbtwcLenHist[0], "<=32": localeFastPathStats.mbtwcLenHist[1],
                "<=128": localeFastPathStats.mbtwcLenHist[2], "<=512": localeFastPathStats.mbtwcLenHist[3],
                "<=4096": localeFastPathStats.mbtwcLenHist[4], "more": localeFastPathStats.mbtwcLenHist[5] },
            topCallers: census === null ? null : [...census.entries()]
                .sort((a, b) => b[1] - a[1]).slice(0, 12)
                .map(([ret, n]) => ({ ret: `0x${ret.toString(16)}`, calls: n })),
        };
        if (opts.reset) localeFastPathStats.reset();
        return snapshot;
    });

    /**
     * codeAudit() — find JS writes of guest-executable bytes that skipped the invalidation
     * chokepoint (memory/guest-code.ts). The gate checks OWNERSHIP of jit_dirty_cache and the
     * allocators cover hand-out; neither can see an in-place write into memory somebody else
     * allocated. This closes that hole at runtime.
     *
     * Sweep 1 arms the audit and hashes every page of every region that may hold executable
     * bytes. Each later sweep re-hashes and reports pages whose bytes CHANGED while NOT being
     * covered by an invalidateGuestCode call since the previous sweep — by construction the
     * page v86 may still be running a stale compiled block for. A guest store would have
     * dirtied the page itself (TLB_HAS_CODE), so a hit is a JS write, and `bytes` shows what
     * landed there. Drive it between tickFrames batches to bracket the write in time.
     */
    svc.register("codeAudit", (args) => {
        const [opts] = args as [{ dump?: boolean; kinds?: string[]; wholeImage?: boolean } | undefined];
        const proc = System.getInstance().process;
        if (!proc) throw new Error("codeAudit: no process");
        const mem = proc.addressSpace.getMemory();
        const covered = new Set(takeGuestCodeAuditPages(true));

        const wanted = new Set<RegionKind>(
            (opts?.kinds as RegionKind[] | undefined) ??
            (["LOW_MEM", "THUNK_CODE", "CALLBACK_STUB", "SPIN_LOOP"] as RegionKind[]),
        );
        const pages: number[] = [];
        const owners = new Map<number, string>();
        const add = (from: number, to: number, label: string) => {
            for (let a = from & ~0xfff; a < Math.min(to, mem.length); a += 0x1000) {
                const p = a >>> 12;
                if (owners.has(p)) continue;
                owners.set(p, label);
                pages.push(p);
            }
        };
        for (const r of proc.addressSpace.getRegions()) {
            const exec = wanted.has(r.kind) || r.perms === "rx" || r.perms === "rwx";
            if (!exec) continue;
            const label = `${r.kind}${r.tag ? ":" + r.tag : ""}`;
            // A PE image region spans the whole image — .data churns constantly under the
            // guest's own stores and would bury the signal. Narrow it to the sections the
            // loader mapped executable, read back out of the image v86 is actually running.
            const secs = opts?.wholeImage ? null : peExecutableSections(mem, r.base);
            if (secs) for (const [from, to] of secs) add(from, to, `${label}@0x${r.base.toString(16)}`);
            else add(r.base, r.base + r.size, label);
        }

        const changed: Array<{ page: string; owner: string; covered: boolean; bytes?: string }> = [];
        const u32 = new Uint32Array(mem.buffer, mem.byteOffset, mem.byteLength >>> 2);
        for (const p of pages) {
            const base = p << 12;
            let h = 0x811c9dc5;
            for (let i = base >>> 2, e = i + 1024; i < e; i++) h = Math.imul(h ^ u32[i]!, 0x01000193);
            h >>>= 0;
            const prev = auditHashes.get(p);
            auditHashes.set(p, h);
            if (prev === undefined || prev === h) continue;
            const entry: { page: string; owner: string; covered: boolean; bytes?: string } = {
                page: `0x${base.toString(16)}`,
                owner: owners.get(p) ?? "?",
                covered: covered.has(p),
            };
            if (opts?.dump) {
                entry.bytes = [...mem.subarray(base, base + 64)]
                    .map((b) => b.toString(16).padStart(2, "0")).join(" ");
            }
            if (!entry.covered) changed.push(entry);
        }
        return { pagesScanned: pages.length, coveredPages: covered.size, uncoveredChanges: changed.length, changed: changed.slice(0, 64) };
    });

    /** evalWorker(code) — evaluate a JS function body IN the worker, return its result.
     *  Bindings: dbg (debug command table), System, d3d9Devices (live D3D9Device map),
     *  state (a persistent scratch object shared across evalWorker calls — park originals
     *  there when monkey-patching so a later call can restore them). Complements the
     *  reload workflow: a diagnostic hook can be installed INTO A RUNNING GAME (TS
     *  `private` is compile-time only, so instance fields/methods are reachable), where
     *  a worker reload costs a full multi-GB reboot. Diagnostics only — shipping
     *  behavior still lands in source + reload. */
    const evalState: Record<string, unknown> = {};
    svc.register("evalWorker", async (args) => {
        const code = String(args[0] ?? "");
        if (!code) throw new Error("evalWorker: empty code");
        const d3d9Devices = (await import("../../modules/d3d9/shared-state")).devices;
        const fn = new Function(
            "dbg", "System", "d3d9Devices", "state",
            `"use strict"; return (async () => { ${code} })();`,
        );
        return (await fn(dbg, System, d3d9Devices, evalState)) ?? null;
    });

    /** dbgCall(name, ...args) — invoke dbg[name](...args), return its result. */
    svc.register("dbgCall", (args) => {
        const [name, ...rest] = args as [string, ...unknown[]];
        const fn = (dbg as Record<string, unknown>)[name];
        if (typeof fn !== "function") {
            throw new Error(`dbgCall: unknown dbg command '${name}'`);
        }
        return (fn as (...a: unknown[]) => unknown)(...rest) ?? null;
    });

    /** setWorkerFlag(name, value) — set a worker-global kill switch (the boot-time
     *  `globalThis.__no*` A/B flags like __noDrawWbuf / __noSetterShadow /
     *  __noStateBlockWbuf). Must run BEFORE the game load that registers the affected
     *  path (registration reads the flag once). Returns the previous value. */
    /** guestAccessCensus({reset?, arm?}) — WHO makes the host-side guest memory accesses
     *  that show up as `cpu::safe_read32s` / `safe_write32` in a profile.
     *
     *  A JIT block never enters those: its read is inlined and its miss calls
     *  safe_read*_slow_jit, a different function. So the profile alone cannot name the
     *  owner, and `analyze-trace`'s old "(TLB miss path)" label asserted one it could not
     *  know. The classes are interpreter / hypercall / eagl-hypercall, and the residual
     *  `other` is the answer that matters: an instruction helper called BY a JIT block.
     *
     *  Counting is OFF until armed (`{arm:true}`), so the tracked path costs one
     *  predictable branch when nobody is measuring — and a window nobody armed reports
     *  `armed:false` rather than a plausible zero. Counts, not time: every class pays the
     *  same page translation per access, so the shares are comparable, but a class doing
     *  wider accesses will be understated. */
    svc.register("guestAccessCensus", (args) => {
        const opts = (args[0] ?? {}) as { reset?: boolean; arm?: boolean };
        const ex = (globalThis as any).preemption?.getWasmExports?.();
        if (!ex?.guest_access_reads) {
            throw new Error("guest_access_* exports missing — rebuild vendor/v86 (build-wasm.sh)");
        }
        if (opts.arm !== undefined) ex.guest_access_set_tracking(opts.arm ? 1 : 0);
        const names = ["other(jit-called helper)", "interpreter", "hypercall", "hypercall-eagl"];
        const classes = names.map((name, i) => ({
            name,
            reads: ex.guest_access_reads(i) >>> 0,
            writes: ex.guest_access_writes(i) >>> 0,
        }));
        const reads = classes.reduce((a, c) => a + c.reads, 0);
        const writes = classes.reduce((a, c) => a + c.writes, 0);
        const out = {
            armed: (ex.guest_access_get_tracking?.() ?? 1) !== 0,
            totalReads: reads,
            totalWrites: writes,
            classes: classes.map((c) => ({
                ...c,
                readPct: reads > 0 ? +((100 * c.reads) / reads).toFixed(2) : null,
                writePct: writes > 0 ? +((100 * c.writes) / writes).toFixed(2) : null,
            })),
        };
        if (opts.reset) ex.guest_access_reset();
        return out;
    });

    /** eaglReadCursor({on?, policy?, verify?, reset?}) — the EAGL hypercall's one-entry read TLB.
     *
     *  `guestAccessCensus` measured 97.7 % of all host-side guest READS coming from this one
     *  hypercall, each paying a full address translation per dword. The cursor re-translates
     *  only on a page change. `on:false` is the kill switch (every read falls back), so an
     *  A/B compares both paths on ONE build.
     *
     *  `verify:true` runs BOTH paths per read and counts disagreements — a memory-path change
     *  believed rather than checked is the failure this project keeps paying for. A run is
     *  only evidence when `checked` is large AND `mismatch` is 0; `checked: 0` means the
     *  oracle never ran, not that it passed.
     *
     *  `policy` picks the cursor's LIFETIME: "dispatch" (default, the entry is dropped at
     *  every hypercall entry) or "tlb" (dropped only where v86 drops its own TLB —
     *  full_clear_tlb / clear_tlb / invlpg / trigger_pagefault). Both live in one build, so
     *  the A/B is a call. `invalidations` counts the TLB-site drops: under "tlb" a count in
     *  the same order as the dispatch count means the entry is NOT surviving across
     *  dispatches, which is the other explanation for a null result. */
    svc.register("eaglReadCursor", (args) => {
        const opts = (args[0] ?? {}) as {
            on?: boolean;
            policy?: "dispatch" | "tlb";
            verify?: boolean;
            reset?: boolean;
        };
        const ex = (globalThis as any).preemption?.getWasmExports?.();
        if (!ex?.eagl_read_cursor_get) {
            throw new Error("eagl_read_cursor_* exports missing — rebuild vendor/v86 (build-wasm.sh)");
        }
        if (!ex.eagl_read_cursor_get_policy) {
            throw new Error("eagl_read_cursor_*_policy missing — stale v86.wasm, rebuild vendor/v86");
        }
        if (opts.reset) ex.eagl_read_cursor_reset_stats();
        if (opts.on !== undefined) ex.eagl_read_cursor_set(opts.on ? 1 : 0);
        if (opts.policy !== undefined) {
            if (opts.policy !== "dispatch" && opts.policy !== "tlb") {
                throw new Error(`eaglReadCursor: policy must be "dispatch" or "tlb"`);
            }
            ex.eagl_read_cursor_set_policy(opts.policy === "tlb" ? 1 : 0);
        }
        if (opts.verify !== undefined) {
            if (!ex.eagl_read_cursor_set_verify) {
                throw new Error("eagl_read_cursor_set_verify missing — stale v86.wasm, rebuild vendor/v86");
            }
            ex.eagl_read_cursor_set_verify(opts.verify ? 1 : 0);
        }
        const checked = ex.eagl_read_cursor_checked() >>> 0;
        const mismatch = ex.eagl_read_cursor_mismatch() >>> 0;
        return {
            on: ex.eagl_read_cursor_get() !== 0,
            policy: ex.eagl_read_cursor_get_policy() !== 0 ? "tlb" : "dispatch",
            invalidations: ex.eagl_read_cursor_invalidations() >>> 0,
            checked,
            mismatch,
            verdict: checked === 0 ? "oracle did not run" : (mismatch === 0 ? "agree" : "DISAGREE"),
        };
    });

    /** d3d9GuestRefcount({on?, verify?, reset?}) — where a D3D9 COM object's refcount lives.
     *
     *  `on` moves the count of record into the guest COM block (real COM's own layout, and the
     *  prerequisite for making AddRef/Release no-trap guest stubs); `verify` maintains BOTH the
     *  guest word and the JS mirror per call and counts disagreements. Both are read live, so an
     *  A/B compares the two storages on ONE boot.
     *
     *  A run is evidence only when `checked` is large AND `mismatch` is 0; `checked: 0` reports
     *  "oracle did not run", never a pass. */
    svc.register("d3d9GuestRefcount", (args) => {
        const opts = (args[0] ?? {}) as { on?: boolean; verify?: boolean; reset?: boolean };
        const g = globalThis as Record<string, unknown>;
        if (opts.on !== undefined) g.__d3d9GuestRefcount = !!opts.on;
        if (opts.verify !== undefined) g.__d3d9RefcountVerify = !!opts.verify;
        return d3d9RefcountStorageStats(!!opts.reset);
    });

    /** d3d9StateBlockShadow({reset?}) — did a recorded state block lose setters?
     *
     *  A shadowed setter skips in GUEST code, so a setter elided while BeginStateBlock was
     *  active never reaches the device and never reaches the BLOCK either. Real D3D9 records
     *  every Set* issued while recording; the damage from dropping one surfaces much later, as
     *  an Apply that fails to restore a state, with nothing logged. `elided` is the guest skip
     *  counters' delta across each Begin..End window — the same words the trampolines and the
     *  EAGL WASM path bump — and it can only be non-zero if the owner gate was left armed
     *  during recording, which is the bug this counter exists to see coming back.
     *
     *  `windows: 0` means no block was recorded while you were watching; it is not a pass. */
    svc.register("d3d9StateBlockShadow", (args) => {
        const opts = (args[0] ?? {}) as { reset?: boolean };
        return d3d9StateBlockShadowStats(!!opts.reset);
    });

    /** d3d9GuestAddRef({on?, verify?, reset?}) — IDirect3DTexture9::AddRef answered in guest code.
     *
     *  40.4 % of every WASM→JS crossing an in-game D3D9 title makes is this one method, whose
     *  JS body is an increment. With the count of record in the guest COM block the whole thing
     *  is `inc [this+4]; mov eax,[this+4]; ret 4` and costs no crossing at all.
     *
     *  BOOT-TIME, unlike the storage flags: installing patches a guest stub and there is no
     *  unpatch path. `on`/`verify` therefore set the flag for the NEXT boot and the returned
     *  `mode` reports what is actually installed RIGHT NOW — the two disagreeing is the normal
     *  state immediately after a call, not a bug.
     *
     *  `verify` installs the non-mutating oracle instead of the stub: guest code predicts the
     *  value the stub would return, still traps, and the JS handler compares. A run is evidence
     *  only when `checked` is large AND `mismatch` is 0; `checked: 0` says the oracle never ran.
     *  `unpredicted` counts calls the trampoline declined (null `this`, vtable gate closed) —
     *  the stub abstaining, not a disagreement. */
    svc.register("d3d9GuestAddRef", (args) => {
        const opts = (args[0] ?? {}) as { on?: boolean; verify?: boolean; reset?: boolean };
        const g = globalThis as Record<string, unknown>;
        if (opts.on !== undefined) g.__d3d9GuestAddRefStub = !!opts.on;
        if (opts.verify !== undefined) g.__d3d9AddRefStubVerify = !!opts.verify;
        return {
            ...d3d9GuestAddRefStats(!!opts.reset),
            requestedOn: !!g.__d3d9GuestAddRefStub,
            requestedVerify: !!g.__d3d9AddRefStubVerify,
            guestRefcount: !!g.__d3d9GuestRefcount,
            appliesAt: "next boot (the stub patch has no unpatch path)",
        };
    });

    /** d3d9GuestRelease({on?, verify?, reset?}) — IDirect3DTexture9::Release answered in guest code.
     *
     *  The other 40.4 % of the crossings, with one difference that shapes everything: the 1→0
     *  transition runs the finalizer and the disposer, so the emitted body tests BEFORE it
     *  decrements and hands a count of 1 (or a bogus 0) back to the OUT trap untouched. Only the
     *  above-zero decrements are removed.
     *
     *  BOOT-TIME, like d3d9GuestAddRef: installing patches a guest stub and there is no unpatch
     *  path, so `on`/`verify` set the flag for the NEXT boot while `mode` reports what is
     *  installed right now.
     *
     *  `verify` installs the non-mutating oracle. It checks BOTH prediction kinds: the value the
     *  stub would have answered, and — separately counted as `zeroChecked` — the count it read
     *  when it decided to decline, against the answer JS produced. `checked: 0` says the oracle
     *  never ran; `zeroChecked: 0` says it never covered a destruction, and the verdict says so
     *  rather than reading as a clean pass. */
    svc.register("d3d9GuestRelease", (args) => {
        const opts = (args[0] ?? {}) as { on?: boolean; verify?: boolean; reset?: boolean };
        const g = globalThis as Record<string, unknown>;
        if (opts.on !== undefined) g.__d3d9GuestReleaseStub = !!opts.on;
        if (opts.verify !== undefined) g.__d3d9ReleaseStubVerify = !!opts.verify;
        return {
            ...d3d9GuestReleaseStats(!!opts.reset),
            requestedOn: !!g.__d3d9GuestReleaseStub,
            requestedVerify: !!g.__d3d9ReleaseStubVerify,
            guestRefcount: !!g.__d3d9GuestRefcount,
            streamRing: !!g.__d3d9StreamRing,
            appliesAt: "next boot (the stub patch has no unpatch path)",
        };
    });

    /** d3d9PipelineMemo({on?, verify?, reset?}) — prologue memo for resolveProgrammablePipeline.
     *
     *  The function already ends in a numeric last-resolve compare that reuses the previous
     *  draw's pipeline, but ~2 us of derived state is rebuilt before that compare can run.
     *  `on` short-circuits straight to the shared reuse tail when no input to any of those
     *  derived values moved; `verify` runs the full prologue anyway and checks the prediction.
     *  Both live-read, so an A/B runs in one boot.
     *
     *  `hits` counts short-circuits taken (0 while verifying — verify deliberately runs the
     *  long path). A run is evidence only when `checked` is large AND `mismatch` is 0;
     *  `checked: 0` reports "oracle did not run", never a pass.
     *
     *  `profile` splits a HIT into guard / tail / whole-call microseconds, with `clockUs` (two
     *  adjacent clock reads) as the instrument's own floor. Read it with
     *  `d3d9PipelineMemoProfile`. */
    svc.register("d3d9PipelineMemo", (args) => {
        const opts = (args[0] ?? {}) as {
            on?: boolean; verify?: boolean; reset?: boolean; profile?: boolean;
        };
        const g = globalThis as Record<string, unknown>;
        if (opts.on !== undefined) g.__d3d9PipelineMemo = !!opts.on;
        if (opts.verify !== undefined) g.__d3d9PipelineMemoVerify = !!opts.verify;
        if (opts.profile !== undefined) g.__d3d9PipelineMemoProfile = !!opts.profile;
        return d3d9PipelineMemoStats(!!opts.reset);
    });

    /** d3d9PipelineMemoProfile({reset?}) — where a memo HIT's microseconds go.
     *
     *  `guardUs` is the match test, `hashUs` the marginal cost of the streamHash inside it,
     *  `tailUs` the shared reuse work a memo hit and a last-resolve hit both do — that tail is
     *  NOT overhead, it is the floor under any memo and no guard change can remove it.
     *  `clockUs` is the measurement floor; the verdict says so when a bucket sits on it.
     *  Requires `d3d9PipelineMemo({profile: true})`, or every bucket reads "did not run".
     *
     *  Measured in-race on NFSU (188,041 hits): guard 0.237 us against a 0.158 us floor —
     *  the guard is not the cost. tail 0.622 us, of which `noteDrawUs` 0.324 us is shader
     *  attribution, which is what `__d3d9FastDrawAttribution` removes. */
    svc.register("d3d9PipelineMemoProfile", (args) => {
        const opts = (args[0] ?? {}) as { reset?: boolean };
        return d3d9PipelineMemoProfileStats(!!opts.reset);
    });

    svc.register("setWorkerFlag", (args) => {
        const [name, value] = args as [string, unknown];
        if (typeof name !== "string" || !name.startsWith("__")) {
            throw new Error(`setWorkerFlag: refusing non-dunder flag '${String(name)}'`);
        }
        const g = globalThis as Record<string, unknown>;
        const prev = g[name];
        g[name] = value;
        noteAppliedWorkerFlag(name);
        return { name, value, prev: prev ?? null };
    });

    /** resetWorkerFlags() — drop every flag applied to the LIVE worker this session.
     *
     *  The host clears the localStorage envelope, which only decides what the NEXT worker
     *  sees; without this the current one keeps running the old arm. Deleting in one
     *  synchronous turn is atomic against the guest (§3.6, shared worker thread), so no
     *  flag is read half-cleared. Boot-time flags are not undone — only re-read on load. */
    svc.register("resetWorkerFlags", () => {
        const g = globalThis as Record<string, unknown>;
        const applied = g[APPLIED_WORKER_FLAGS] as Set<string> | undefined;
        const cleared = applied ? Array.from(applied) : [];
        for (const name of cleared) delete g[name];
        applied?.clear();
        return { cleared, count: cleared.length };
    });
}
