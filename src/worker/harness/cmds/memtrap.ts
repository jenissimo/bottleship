/**
 * Memory write-trap commands — diagnose "the guest never writes here" mysteries
 * (a DDraw surface whose CPU pixels stay zero despite a Lock/fill). Built on the
 * recoverable #PF handler: trapWrites() flips pages to read-only, a guest store
 * faults → we record the writer EIP, un-protect the page so the store lands, and
 * the guest continues unaware.
 *
 *   trapWrites(addr, len?, label?) — arm over [addr, addr+len) (default 4KB).
 *   memTrapReport()                — writer EIPs (module+offset) AND what was unobservable.
 *   memTrapClear()                 — restore RW and stop trapping.
 *
 * READ `verdict`, NOT `hits.length`. Letting a trapped store land means the page is
 * writable for one v86 block, and a #PF cannot see a JS or WASM-hypercall write at
 * all — so an empty `hits` has never meant "nobody wrote here" on its own. The
 * report says which of the two it is: it counts the blind windows it opened and
 * SAMPLES the watched bytes, so a change it could not attribute comes back as
 * `changed: true` + `unattributedChanges`, never as silence. No JIT-off required.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { memWriteTrap } from "../../core/memory/mem-write-trap";
import { jsWriteTrap } from "../../core/memory/js-write-trap";
import { hypercallDataManager } from "../../core/cpu/hypercall-data";
import { symbolize } from "../serialize";

function toAddr(x: unknown): number {
    if (typeof x === "number") return x >>> 0;
    const s = String(x ?? "").trim();
    if (!s) throw new HarnessError("expected an address", HarnessErrorCode.BAD_ARGS);
    return (s.startsWith("0x") || s.startsWith("0X") ? parseInt(s.slice(2), 16) : parseInt(s, 16)) >>> 0;
}

export function registerMemTrapCommands(svc: HarnessService): void {
    svc.register("trapWrites", (args) => {
        const addr = toAddr(args[0]);
        const len = args[1] != null ? Math.max(1, Number(args[1]) | 0) : 0x1000;
        const label = args[2] != null ? String(args[2]) : "";
        const opts = (args[3] ?? {}) as { trace?: boolean; watch?: boolean; recordAddr?: number; recordLen?: number; slice?: number };
        const res = memWriteTrap.arm(addr, len, label, opts);
        return {
            ...res,
            note: opts.watch
                ? "WATCH mode: pages RO; EVERY write to the trapped page(s) faults, the page is re-protected as soon as the faulting instruction retires, and ONLY writes landing in [addr,addr+len) are recorded (with writer EIP). From the FIRST fault on, the guest is throttled to `slice` instructions per JS round trip (default 256) — that is what bounds the blind window a fault opens, and it costs ~100x speed; `slice:0` runs full speed and reports quantum-wide blind windows instead. memTrapReport(): read `verdict` — `hits: []` is only a negative when it says so."
                : opts.trace
                ? "TRACE mode: pages NO-ACCESS; EVERY guest read+write is recorded in order (re-arm scheme) — captures the write→reuse→read sequence on a buffer. Keep the range SMALL (a few pages)."
                : "SINGLE-SHOT: pages are read-only; the first guest store to each faults and is recorded, then the page stays RW — every later store is unseen BY DESIGN (use {watch:true} for repeated writers of one field). memTrapReport() to read; memTrapClear() to restore.",
        };
    });

    svc.register("memTrapReport", () => memWriteTrap.report());

    svc.register("memTrapClear", () => memWriteTrap.disarm());

    /**
     * trapJsWrites(addr, len?, label?) — the JS-side sibling of trapWrites.
     * MemWriteTrap only sees GUEST stores (it needs a #PF); a write our own handlers
     * perform through Mem raises none, so the MMU trap reports zero hits for it and
     * "nobody wrote here" is indistinguishable from "JS wrote here". This arms a range
     * check inside Mem instead, so a corrupted block can be attributed to a thunk.
     *
     * Read with jsWriteReport(): it returns `inspected` (every write offered while
     * armed, not just matches) so a run that observed nothing is distinguishable from a
     * run where the hook never ran, plus `blindSpots` naming the paths it cannot see.
     */
    svc.register("trapJsWrites", (args) => {
        const addr = toAddr(args[0]);
        const len = args[1] != null ? Math.max(1, Number(args[1]) | 0) : 64;
        const label = args[2] != null ? String(args[2]) : "";
        return {
            ...jsWriteTrap.arm(addr, len, label),
            wasmStringWritersOff: hypercallDataManager.areWasmStringWritersOff(),
            note: "Armed inside Mem. Covers JS writes only — WASM hypercall writers and " +
                "direct mem8[] call sites are blind spots (see blindSpots in jsWriteReport). " +
                "Call wasmStringWriters(false) first if a null result must mean anything.",
        };
    });

    svc.register("jsWriteReport", () => {
        const r = jsWriteTrap.report();
        return {
            ...r,
            wasmStringWritersOff: hypercallDataManager.areWasmStringWritersOff(),
            hits: r.hits.map((h) => ({
                ...h,
                addrHex: "0x" + (h.addr >>> 0).toString(16),
                eipSym: symbolize(h.eip),
            })),
        };
    });

    svc.register("jsWriteClear", () => jsWriteTrap.disarm());

    /**
     * wasmStringWriters(on) — route the WASM string/memory handlers that WRITE guest
     * memory (memcpy/memset/strcpy/wcscpy/wcscat/wcsncpy) to their JS fallbacks.
     * Those Rust handlers write through a raw pointer: no #PF and no Mem, so they are
     * invisible to BOTH traps. Turning them off is what makes them observable, and it
     * doubles as the A/B that convicts or clears the WASM implementations.
     * (The heap slab is a separate switch — __noHeapSlab.)
     */
    svc.register("wasmStringWriters", (args) => {
        const on = args[0] === undefined ? true : !!args[0];
        return hypercallDataManager.setWasmStringWritersEnabled(on);
    });
}
