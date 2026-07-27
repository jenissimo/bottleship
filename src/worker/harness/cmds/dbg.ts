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
import { guestCodeInvalidationStats, takeGuestCodeAuditPages } from "../../core/memory/guest-code";
import type { RegionKind } from "../../core/memory/address-space";

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
    svc.register("setWorkerFlag", (args) => {
        const [name, value] = args as [string, unknown];
        if (typeof name !== "string" || !name.startsWith("__")) {
            throw new Error(`setWorkerFlag: refusing non-dunder flag '${String(name)}'`);
        }
        const g = globalThis as Record<string, unknown>;
        const prev = g[name];
        g[name] = value;
        return { name, value, prev: prev ?? null };
    });
}
