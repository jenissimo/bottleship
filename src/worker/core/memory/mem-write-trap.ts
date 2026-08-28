/**
 * MemWriteTrap — page-protection WRITE trap for diagnosing "the guest never
 * writes here" mysteries (e.g. a DDraw surface whose CPU pixels stay zero even
 * though the game Locked it and supposedly filled it).
 *
 * Mechanism: arm() flips the target pages to PAGE_READONLY in the guest page
 * tables. A guest CPU store to those pages raises a real #PF, which our
 * recoverable #PF handler routes to JS via OUT 0xB077,0xDEAD000E →
 * ThunkDispatcher._handleRecoverablePageFault → tryHandle(). We record the
 * faulting EIP, flip that page back to RW so the IRET retry of the store lands,
 * and return — the guest never sees the fault.
 *
 * THE BLIND WINDOW, and why the report leads with it. Letting the retried store
 * land means the page is writable for a moment, and JS has no per-instruction
 * hook to close it again — the earliest it can regain control is the end of the
 * current v86 slice, whose budget was read before the fault (do_many_cycles_native
 * reads the cycle limit once). Narrowing that window therefore means running short
 * slices BEFORE the fault, at roughly a thousandfold cost, so watch mode runs full
 * speed until it catches itself missing a write and only then throttles.
 * Watch mode re-protects the page as soon as the faulting instruction has retired,
 * counts the instructions the window was open for, and — decisively — SAMPLES the
 * watched bytes, so a change nobody attributed is reported as a change, not as
 * silence. Two other writers are invisible by construction and named in the report
 * rather than folded into a zero: JS (our own handlers — no MMU, see trapJsWrites)
 * and the WASM string/memory hypercalls.
 *
 * report().verdict is the whole point: `hits: []` alone can mean "nothing wrote
 * here" or "I could not see it", and only one of those answers the question the
 * verb exists for.
 *
 * Diagnostic only — arm via the harness (trapWrites), never on a hot path.
 */

import { Logger, LogCategory } from "../logger";
import { System } from "../system";
import { preemptionManager } from "../cpu/preemption-manager";

const PAGE_SIZE = 0x1000;
const PAGE_NOACCESS = 0x01;
const PAGE_READONLY = 0x02;
const PAGE_READWRITE = 0x04;
const MAX_HITS = 512;
/** Bytes of the record window folded into the change-detection sample. */
const MAX_SAMPLE_BYTES = 4096;
/** Give up waiting for a faulting instruction to retire (a `rep` store never
 *  leaves its EIP; re-protecting anyway just costs one duplicate fault). */
const MAX_PENDING_TICKS = 64;
/** Forced short slices before the trap stops throttling the guest and says so. */
const FORCED_SLICE_BUDGET = 2_000_000;
/** Default: NO slice throttle — a v86 slice round trip costs a clamped host timer
 *  (~5 ms), so throttling is ~1000x slower and would read as a hang. Instead the trap
 *  runs full speed until it CATCHES ITSELF MISSING a write (a sampled change nobody
 *  faulted for) and only then throttles, so the next one is attributable. */
const DEFAULT_SLICE_INSNS = 0;
/** Slice width the trap escalates to when it detects it missed a write. */
const ESCALATED_SLICE_INSNS = 8;

export interface MemWriteTrapHit {
    /** Faulting linear address (CR2). */
    addr: number;
    /** Page base that was un-protected. */
    page: number;
    /** EIP of the instruction that performed the store. */
    eip: number;
    /** Module+offset annotation for eip, if resolvable. */
    module: string;
    /** Thunk name in flight at fault time (context). */
    thunk: string;
    /** Current guest thread id at fault time (to spot cross-thread races). */
    tid: number | string;
    /** Guest GP registers at fault [eax,ecx,edx,ebx,esp,ebp,esi,edi] (for tracing
     *  the data source of a copy loop — e.g. which reg holds the source pointer). */
    regs: number[];
    /** Return-address chain walked from EBP (resolve via the live module map to
     *  identify the calling functions — e.g. the texture loader above a copier). */
    stack: number[];
    /** Dense-data blocks found near ESI (offset:nonZeroCount) — locates where the
     *  real pixel data lives vs where the source pointer points. */
    srcScan: string[];
    /** Heuristic stack scan: code-pointer-looking values on the guest stack,
     *  resolved to module+offset. Works for FPO frames where EBP-walk fails. */
    rawStack: string[];
    /** Access kind in trace mode: 'R' (read) or 'W' (write). */
    rw: string;
    /** Order of first observation. */
    seq: number;
}

/** A watched-range change the trap could NOT pin on a faulting instruction. */
export interface UnattributedChange {
    /** Sample hash before/after (the window is hashed, so this is an identity, not a value). */
    from: string;
    to: string;
    /** First 8 bytes of the window at each end, for eyeballing. */
    fromHead: string;
    toHead: string;
    /** Instructions retired inside blind windows since the previous sample. */
    blindInsnsSince: number;
    /** Where the sample was taken. */
    at: "tick" | "report";
}

interface PendingReArm {
    page: number;
    protect: number;
    faultEip: number;
    tid: number | string;
    /** The IRET has landed back on the faulting instruction (it may not have run yet). */
    sawEip: boolean;
    insnAtFault: number;
    ticks: number;
}

function currentTid(): number | string {
    try { return System.getInstance().scheduler?.getCurrentThread?.()?.id ?? "?"; } catch { return "?"; }
}

class MemWriteTrap {
    private base = 0;
    private end = 0;
    private armed = false;
    private hits: MemWriteTrapHit[] = [];
    private faultedPages = new Set<number>();
    private seenPages = new Set<number>();
    private seq = 0;
    private label = "";
    /** Trace mode: NO-ACCESS pages, record EVERY read+write in order. */
    private trace = false;
    /** Watch mode: RO pages, re-armed after every fault, but only writes landing in
     *  [recBase,recEnd) are recorded — one field on a busy page, no read-flood. */
    private watch = false;
    private pageBase = 0;
    private pageEnd = 0;
    /** Record window (narrow in watch mode; the whole armed range otherwise). */
    private recBase = 0;
    private recEnd = 0;

    // ── blind-window accounting ────────────────────────────────────────────
    private pending: PendingReArm | null = null;
    private faults = 0;
    private unwatchedFaults = 0;
    private reArms = 0;
    private reArmGiveUps = 0;
    /** Why the last re-arm had to give up — the only thing that explains a wide window. */
    private giveUpDetail: { faultEip: string; tid: number | string; lastEip: string; lastTid: number | string; sawEip: boolean } | null = null;
    private ticksObserved = 0;
    /** First observations while a window was open — what the re-arm actually saw. */
    private pendingTrace: string[] = [];
    private forcedSlices = 0;
    private throttleDegraded = false;
    /** Instructions v86 may retire per slice once a trapped page has faulted. The
     *  blind window a fault opens cannot be closed before the slice it lands in ends
     *  (the cycle limit is read once per slice), so this IS the window's width. */
    private sliceInsns = DEFAULT_SLICE_INSNS;
    private throttling = false;
    private autoEscalate = false;
    private autoEscalated = false;
    private blindInsns = 0;
    private maxBlindInsns = 0;
    private blindInsnsSinceSample = 0;

    // ── change detection (sees writers no #PF can) ─────────────────────────
    private sampleHash = 0;
    private sampleHead = "";
    private sampleCovers = 0;
    private hitsAtSample = 0;
    private unattributed: UnattributedChange[] = [];

    /** Arm a trap over [addr, addr+len). Default: RO (catch first write per page).
     *  opts.trace: NO-ACCESS, catch EVERY read+write in order (re-arm scheme). */
    arm(addr: number, len: number, label = "", opts?: { trace?: boolean; watch?: boolean; recordAddr?: number; recordLen?: number; slice?: number }): { armed: boolean; pages: number; base: number; end: number; trace: boolean; watch: boolean; sliceInsns: number } {
        const ptm = System.getInstance().process?.pageTableManager;
        if (!ptm?.isPagingEnabled()) {
            throw new Error("MemWriteTrap.arm: paging not enabled (no page tables to protect)");
        }
        // Restore any previous arming first.
        if (this.armed) this.disarm();

        this.trace = !!opts?.trace;
        this.watch = !!opts?.watch;
        this.base = addr >>> 0;
        this.end = (addr + Math.max(1, len | 0)) >>> 0;
        // Record window: defaults to the full armed range; in watch mode the caller
        // can pass a NARROW recordAddr/recordLen while arming a WIDE page span.
        this.recBase = (opts?.recordAddr != null ? opts.recordAddr : this.base) >>> 0;
        this.recEnd = (opts?.recordAddr != null ? (opts.recordAddr + Math.max(1, (opts.recordLen ?? 4) | 0)) : this.end) >>> 0;
        const pageBase = this.base & ~(PAGE_SIZE - 1);
        const pageEnd = (this.end + PAGE_SIZE - 1) & ~(PAGE_SIZE - 1);
        this.pageBase = pageBase;
        this.pageEnd = pageEnd;
        const pageLen = pageEnd - pageBase;
        // watch mode uses RO (writes-only faults) + re-arm; trace uses NO-ACCESS.
        ptm.setProtection(pageBase, pageLen, this.trace ? PAGE_NOACCESS : PAGE_READONLY);

        this.armed = true;
        this.hits = [];
        this.faultedPages.clear();
        this.seenPages.clear();
        this.pending = null;
        this.seq = 0;
        this.label = label;
        this.faults = 0;
        this.unwatchedFaults = 0;
        this.reArms = 0;
        this.reArmGiveUps = 0;
        this.giveUpDetail = null;
        this.ticksObserved = 0;
        this.pendingTrace = [];
        this.forcedSlices = 0;
        this.throttleDegraded = false;
        this.sliceInsns = opts?.slice != null ? Math.max(0, opts.slice | 0) : DEFAULT_SLICE_INSNS;
        // Only an unspecified slice escalates: an explicit 0 means "stay fast, I will
        // read the blind-window numbers myself".
        this.autoEscalate = opts?.slice == null;
        this.autoEscalated = false;
        // Throttle from ARM, not from the first fault: the slice a fault lands in was
        // budgeted before the fault and cannot be cut short, so the ONLY way to bound
        // the first blind window is to have been running short slices already.
        this.throttling = (this.watch || this.trace) && this.sliceInsns > 0;
        this.blindInsns = 0;
        this.maxBlindInsns = 0;
        this.blindInsnsSinceSample = 0;
        this.unattributed = [];
        this.hitsAtSample = 0;
        this._takeSample();
        const pages = pageLen / PAGE_SIZE;
        Logger.log(LogCategory.SYSTEM,
            `[MemWriteTrap] armed ${this.trace ? "NO-ACCESS (trace)" : this.watch ? "RO (watch+rearm)" : "RO"} over 0x${pageBase.toString(16)}..0x${pageEnd.toString(16)} ` +
            `(${pages} pages, watch window 0x${this.base.toString(16)}..0x${this.end.toString(16)})${label ? ` [${label}]` : ""}`);
        return { armed: true, pages, base: pageBase, end: pageEnd, trace: this.trace, watch: this.watch, sliceInsns: this.sliceInsns };
    }

    isArmed(): boolean {
        return this.armed;
    }

    /**
     * Called from ThunkDispatcher._handleRecoverablePageFault BEFORE SEH/halt.
     * Returns true if this fault is one of ours (page un-protected, write
     * recorded) — caller must `return` so the IRET retries the store.
     */
    tryHandle(faultAddr: number, faultingEip: number, isWrite: boolean, isPresent: boolean, thunk: string, cpu?: any): boolean {
        if (!this.armed) return false;
        const a = faultAddr >>> 0;
        const ptm = System.getInstance().process?.pageTableManager;
        const page = a & ~(PAGE_SIZE - 1);

        if (this.watch) {
            // Handle EVERY store to the trapped pages (so a busy heap page keeps
            // working) but RECORD only writes landing in [recBase,recEnd).
            if (page < this.pageBase || page >= this.pageEnd) return false;
            if (!isWrite || !isPresent) return false;
            this.faults++;
            this.faultedPages.add(page);
            const inWindow = a >= this.recBase && a < this.recEnd;
            if (!inWindow) this.unwatchedFaults++;
            this._openWindow(ptm, page, PAGE_READONLY, faultingEip, cpu);
            if (inWindow && this.hits.length < MAX_HITS) {
                const hit = this._buildHit(a, page, faultingEip, thunk, cpu, "W");
                this.hits.push(hit);
                Logger.log(LogCategory.SYSTEM,
                    `[MemWriteTrap] WATCH WRITE #${hit.seq} addr=0x${a.toString(16)} ` +
                    `eip=0x${hit.eip.toString(16)}${hit.module ? ` (${hit.module})` : ""} thunk=${hit.thunk || "?"}`);
            }
            return true;
        }

        // Page-scoped, exactly like watch mode above, and for the same reason: BOTH
        // remaining modes protect whole PAGES, so every access to any OTHER byte on them
        // faults too. Rejecting those faults hands the guest a spurious #PF on its own
        // live data — fatal when the trapped field shares a page with a hot object — and
        // because a rejected fault is never counted, report() then says "NO FAULT AT ALL"
        // while the guest is dying of the trap. Serve every fault on the armed pages;
        // record only the ones inside the requested byte window.
        if (page < this.pageBase || page >= this.pageEnd) return false;
        const inWindow = a >= this.base && a < this.end;

        if (this.trace) {
            this.faults++;
            this.faultedPages.add(page);
            if (!inWindow) this.unwatchedFaults++;
            this._openWindow(ptm, page, PAGE_NOACCESS, faultingEip, cpu);
            if (inWindow && this.hits.length < MAX_HITS) {
                const hit = this._buildHit(a, page, faultingEip, thunk, cpu, isWrite ? "W" : "R");
                this.hits.push(hit);
            }
            return true;
        }

        if (!isWrite || !isPresent) return false;
        if (!inWindow) {
            // Out-of-window store on an armed page: let it through on a TRANSIENT window
            // (re-protected at the next tick boundary) instead of un-protecting for good,
            // so the one write this mode exists to catch is still trapped afterwards.
            this.faults++;
            this.unwatchedFaults++;
            this._openWindow(ptm, page, PAGE_READONLY, faultingEip, cpu);
            return true;
        }
        this.faults++;
        this.faultedPages.add(page);
        // Single-shot mode: un-protect for good so the whole fill lands. The blind
        // window is the rest of the run, by design — one writer EIP per page is the
        // question here, and report() says so.
        ptm?.setProtection(page, PAGE_SIZE, PAGE_READWRITE);

        if (!this.seenPages.has(page) && this.hits.length < MAX_HITS) {
            this.seenPages.add(page);
            const hit = this._buildHit(a, page, faultingEip, thunk, cpu, "W");
            this.hits.push(hit);
            Logger.log(LogCategory.SYSTEM,
                `[MemWriteTrap] WRITE #${hit.seq} addr=0x${a.toString(16)} page=0x${page.toString(16)} ` +
                `eip=0x${hit.eip.toString(16)}${hit.module ? ` (${hit.module})` : ""} thunk=${hit.thunk || "?"}`);
        }
        return true;
    }

    /**
     * Called at every v86 tick boundary (tick_hooks_before, AFTER the cycle budget is
     * set — a smaller budget written here is what bounds the next blind window). Two
     * jobs, both cheap and both no-ops while disarmed:
     *   1. Close the blind window — re-protect the page whose fault we just served, as
     *      soon as the faulting instruction has retired. "Retired" is read off EIP:
     *      the IRET lands back ON the faulting instruction, so the window closes on the
     *      first boundary where EIP has left it again.
     *   2. Sample the watched bytes, so a change with no fault behind it (JS, a WASM
     *      hypercall, or a store inside the blind window) is REPORTED as a change.
     */
    onTickBoundary(cpu: any): void {
        if (!this.armed) return;
        this.ticksObserved++;
        const p = this.pending;
        if (p) {
            const eip = (cpu?.instruction_pointer?.[0] ?? 0) >>> 0;
            const tid = currentTid();
            if (this.pendingTrace.length < 24) {
                this.pendingTrace.push(`t${this.ticksObserved} eip=0x${eip.toString(16)} tid=${tid} saw=${p.sawEip ? 1 : 0} insn=+${(((cpu?.instruction_counter?.[0] ?? 0) >>> 0) - p.insnAtFault) | 0}`);
            }
            let close = false;
            const note = (): void => {
                this.giveUpDetail = {
                    faultEip: "0x" + p.faultEip.toString(16), tid: p.tid,
                    lastEip: "0x" + eip.toString(16), lastTid: tid, sawEip: p.sawEip,
                };
            };
            if (tid !== p.tid) {
                // Another thread is running; the faulting store has not retried yet.
                // Waiting is right, but not forever — the owner may be blocked.
                close = ++p.ticks > MAX_PENDING_TICKS;
                if (close) { this.reArmGiveUps++; note(); }
            } else if (!p.sawEip) {
                if (eip === p.faultEip) p.sawEip = true;
                close = ++p.ticks > MAX_PENDING_TICKS;
                if (close) { this.reArmGiveUps++; note(); }
            } else if (eip !== p.faultEip) {
                close = true;
            } else if (++p.ticks > MAX_PENDING_TICKS) {
                close = true;
                this.reArmGiveUps++;
                note();
            }
            if (!close) {
                // Finest re-arm the host allows: one block, then look again.
                if (this.sliceInsns > 0) this._narrowSlice(1);
                this._checkSample("tick");
                return;
            }
            this._closeWindow(cpu);
        }
        if (this.throttling) {
            // No window open, but the next fault will open one — and the slice it lands
            // in can no longer be shortened once it has started. Bounding the slice HERE
            // is what bounds that window, including the slice right after a close.
            this._narrowSlice(this.sliceInsns);
        }
        this._checkSample("tick");
    }

    /** Un-protect `page` for the retried store and remember to close it again. */
    private _openWindow(ptm: any, page: number, protect: number, faultingEip: number, cpu: any): void {
        // A second fault before the first window closed (other thread / other page):
        // close the old one now. It may re-fault, which costs a duplicate record but
        // never a missed one.
        if (this.pending) this._closeWindow(cpu);
        ptm?.setProtection(page, PAGE_SIZE, PAGE_READWRITE);
        this.pending = {
            page, protect, faultEip: faultingEip >>> 0, tid: currentTid(), sawEip: false,
            insnAtFault: (cpu?.instruction_counter?.[0] ?? 0) >>> 0, ticks: 0,
        };
    }

    private _closeWindow(cpu: any): void {
        const p = this.pending;
        if (!p) return;
        this.pending = null;
        const ptm = System.getInstance().process?.pageTableManager;
        ptm?.setProtection(p.page, PAGE_SIZE, p.protect);
        this.reArms++;
        const now = (cpu?.instruction_counter?.[0] ?? 0) >>> 0;
        const open = (now - p.insnAtFault) | 0;
        if (open > 0) {
            this.blindInsns += open;
            this.blindInsnsSinceSample += open;
            if (open > this.maxBlindInsns) this.maxBlindInsns = open;
        }
    }

    /** Bound the coming slice. The budget stops a forgotten trap from throttling a
     *  session forever — and says so rather than quietly widening the window. */
    private _narrowSlice(insns: number): void {
        if (this.throttleDegraded) return;
        if (++this.forcedSlices > FORCED_SLICE_BUDGET) {
            this.throttleDegraded = true;
            Logger.warn(LogCategory.SYSTEM,
                `[MemWriteTrap] slice budget exhausted after ${this.forcedSlices} slices — ` +
                `throttling off, blind windows widen to a full quantum (see report().blind)`);
            return;
        }
        preemptionManager.requestBoundedSlice(insns);
    }

    // ── change detection ───────────────────────────────────────────────────

    private _hashWindow(): { hash: number; head: string; covers: number } {
        const mem = System.getInstance().process?.getCurrentMemory?.();
        const lo = this.recBase >>> 0;
        const hi = Math.min(this.recEnd >>> 0, lo + MAX_SAMPLE_BYTES);
        if (!mem || hi <= lo || hi > mem.length) return { hash: 0, head: "", covers: 0 };
        let h = 0x811c9dc5;
        for (let i = lo; i < hi; i++) {
            h ^= mem[i]!;
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        let head = "";
        for (let i = lo; i < Math.min(hi, lo + 8); i++) head += mem[i]!.toString(16).padStart(2, "0");
        return { hash: h >>> 0, head, covers: hi - lo };
    }

    private _takeSample(): void {
        const s = this._hashWindow();
        this.sampleHash = s.hash;
        this.sampleHead = s.head;
        this.sampleCovers = s.covers;
        this.hitsAtSample = this.hits.length;
        this.blindInsnsSinceSample = 0;
    }

    private _checkSample(at: "tick" | "report"): void {
        const s = this._hashWindow();
        if (s.covers === 0 || s.hash === this.sampleHash) return;
        // A change with a fault behind it is already attributed; only the rest is news.
        if (this.hits.length === this.hitsAtSample && this.unattributed.length < 64) {
            this.unattributed.push({
                from: "0x" + this.sampleHash.toString(16), to: "0x" + s.hash.toString(16),
                fromHead: this.sampleHead, toHead: s.head,
                blindInsnsSince: this.blindInsnsSinceSample, at,
            });
            // Caught ourselves missing a write: narrow the window so the NEXT one is
            // attributable, rather than reporting the same blind zero again.
            if (this.autoEscalate && this.sliceInsns === 0 && (this.watch || this.trace)) {
                this.sliceInsns = ESCALATED_SLICE_INSNS;
                this.throttling = true;
                this.autoEscalated = true;
                Logger.warn(LogCategory.SYSTEM,
                    `[MemWriteTrap] a watched change was NOT attributed to any fault — throttling to ` +
                    `${ESCALATED_SLICE_INSNS} insn/slice (guest slows sharply) so the next write is caught`);
            }
        }
        this.sampleHash = s.hash;
        this.sampleHead = s.head;
        this.sampleCovers = s.covers;
        this.hitsAtSample = this.hits.length;
        this.blindInsnsSinceSample = 0;
    }

    private _buildHit(a: number, page: number, faultingEip: number, thunk: string, cpu: any, rw: string): MemWriteTrapHit {
        let module = "";
        const mr = System.getInstance().process?.moduleRegistry;
        const mod = mr?.getModuleContainingAddress?.(faultingEip >>> 0);
        if (mod) module = `${mod.name}+0x${((faultingEip >>> 0) - mod.baseAddress).toString(16)}`;
        const regs: number[] = [];
        const r = cpu?.reg32;
        if (r) for (let i = 0; i < 8; i++) regs.push((r[i] >>> 0));
        // Walk the EBP chain for the call stack (best-effort; standard frames).
        const stack: number[] = [];
        try {
            const m = System.getInstance().process?.getCurrentMemory?.();
            if (m && r) {
                const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
                let ebp = (r[5] >>> 0);
                for (let i = 0; i < 12 && ebp > 0x1000 && ebp + 8 <= m.length; i++) {
                    stack.push(dv.getUint32(ebp + 4, true) >>> 0);
                    const next = dv.getUint32(ebp, true) >>> 0;
                    if (next <= ebp) break;
                    ebp = next;
                }
            }
        } catch { /* best-effort */ }
        const tid = currentTid();
        // For a copy loop, scan around the source register (ESI=regs[6]) to find
        // where dense pixel data actually lives relative to the source pointer —
        // exposes a stale/offset source pointer (data present but N KB away).
        const srcScan: string[] = [];
        try {
            const m = System.getInstance().process?.getCurrentMemory?.();
            const esi = r ? (r[6] >>> 0) : 0;
            if (m && esi > 0x1000) {
                const lo = Math.max(0, esi - 0x40000), hi = Math.min(m.length, esi + 0x40000);
                for (let p = lo & ~0xfff; p + 0x1000 <= hi; p += 0x1000) {
                    let nz = 0; for (let i = 0; i < 0x1000; i += 7) if (m[p + i]) nz++;
                    if (nz > 100) srcScan.push(`${esi <= p ? "+" : "-"}0x${Math.abs(p - esi).toString(16)}:${nz}`);
                }
            }
        } catch { /* best-effort */ }
        // Heuristic stack scan (FPO-proof): from the guest ESP, collect words
        // that resolve to a loaded module's code → the call chain. The #PF stub
        // pushed 24 bytes (saved EAX/EDX + errcode + EIP + CS + EFLAGS) over the
        // faulting frame, so the guest ESP = handler ESP + 24.
        const rawStack: string[] = [];
        try {
            const m = System.getInstance().process?.getCurrentMemory?.();
            const mreg = System.getInstance().process?.moduleRegistry as any;
            if (m && r && mreg?.getModuleContainingAddress) {
                const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
                const gesp = ((r[4] >>> 0) + 24) >>> 0;
                const seen = new Set<string>();
                for (let off = 0; off < 0x300 && gesp + off + 4 <= m.length && rawStack.length < 16; off += 4) {
                    const v = dv.getUint32(gesp + off, true) >>> 0;
                    if (v < 0x400000) continue;
                    const mo = mreg.getModuleContainingAddress(v);
                    if (!mo) continue;
                    const s = `${mo.name}+0x${(v - mo.baseAddress).toString(16)}`;
                    if (!seen.has(s)) { seen.add(s); rawStack.push(s); }
                }
            }
        } catch { /* best-effort */ }
        return {
            addr: a, page, eip: faultingEip >>> 0, module, thunk: thunk || "", tid, regs, stack, srcScan, rawStack, rw, seq: this.seq++,
        };
    }

    /**
     * Snapshot of what was observed — and of what could not be. `verdict` is the
     * field to read: an empty `hits` on its own does not distinguish "nothing wrote
     * here" from "the write happened where this trap cannot see".
     */
    report(): {
        armed: boolean; label: string; base: number; end: number; pagesHit: number;
        hits: MemWriteTrapHit[]; verdict: string;
        blind: {
            faults: number; unwatchedFaults: number; reArms: number; reArmGiveUps: number;
            blindInsns: number; maxBlindInsns: number; throttleDegraded: boolean;
            windowOpen: boolean; sliceInsns: number; throttling: boolean; autoEscalated: boolean;
            ticksObserved: number; pendingTrace: string[];
            giveUpDetail: { faultEip: string; tid: number | string; lastEip: string; lastTid: number | string; sawEip: boolean } | null;
        };
        changed: boolean; unattributedChanges: UnattributedChange[];
        sample: { covers: number; head: string; hash: string };
        blindSpots: string[];
    } {
        this._checkSample("report");
        const changed = this.unattributed.length > 0;
        const singleShot = !this.watch && !this.trace;
        // Single-shot mode un-protects each page for good on its first write, so
        // everything after that write is blind by design — that is the mode, not a defect.
        const blindNote = singleShot
            ? `${this.faultedPages.size} page(s) went RW on their first write (single-shot mode) and every later store to them was unseen`
            : `blind windows totalling ${this.blindInsns} instruction(s) (worst ${this.maxBlindInsns})` +
              (this.throttleDegraded ? ", THROTTLING OFF after the forced-slice budget — windows are quantum-wide" : "");
        const blindOpen = singleShot ? this.faults > 0 : (this.blindInsns > 0 || this.pending !== null || this.throttleDegraded);
        let verdict: string;
        if (!this.armed && this.faults === 0 && this.hits.length === 0) {
            verdict = "NOT ARMED — nothing was observed at all (arm with trapWrites first)";
        } else if (this.hits.length > 0) {
            verdict = `WROTE: ${this.hits.length} guest store(s) attributed to ${new Set(this.hits.map(h => h.eip)).size} EIP(s)`;
        } else if (changed) {
            verdict = "WROTE, UNATTRIBUTED — the watched bytes CHANGED with no fault behind the change. " +
                (blindOpen
                    ? `A guest store inside a blind window (${blindNote}), or a write no #PF can see (JS / WASM hypercall). ` +
                      "Re-run with `{watch:true, slice:8}` to narrow the window to a few instructions (slow), " +
                      "and `trapJsWrites`/`wasmStringWriters(false)` to rule the invisible writers in or out."
                    : "No blind window was open, so this was NOT a guest store through the trapped page: it was JS or a WASM string/memory hypercall (see trapJsWrites, wasmStringWriters).");
        } else if (this.ticksObserved === 0 && this.faults > 0) {
            verdict = "INCONCLUSIVE — the trap faulted but never saw a v86 tick boundary, so it could not re-protect " +
                "the page: everything after the first fault ran with the page writable. (Guest code driven from " +
                "inside a JS turn — run_guest_until — bypasses the tick hooks entirely.)";
        } else if (this.faults === 0) {
            verdict = `NO FAULT AT ALL — nothing ${this.trace ? "read or wrote" : "wrote to"} these PAGES while armed. ` +
                "Check the trap was armed on the right address (and that the page was not re-committed under it); " +
                `a guest ${this.trace ? "access" : "store"} here would have faulted.`;
        } else if (blindOpen) {
            verdict = `NO WRITE OBSERVED, NOT PROOF — ${this.faults} fault(s) on these pages, ${blindNote}; ` +
                "a store to the watched bytes inside one of those is unseen. The sampled bytes did not change, " +
                "which is the stronger negative here.";
        } else {
            verdict = "NO GUEST WRITE — the trapped pages faulted, nothing landed in the watched bytes, no blind " +
                "window was open and the bytes did not change. A JS / WASM-hypercall write is still invisible by construction.";
        }
        return {
            armed: this.armed,
            label: this.label,
            base: this.base >>> 0,
            end: this.end >>> 0,
            pagesHit: this.faultedPages.size,
            hits: this.hits.slice(),
            verdict,
            blind: {
                faults: this.faults, unwatchedFaults: this.unwatchedFaults, reArms: this.reArms,
                reArmGiveUps: this.reArmGiveUps, blindInsns: this.blindInsns,
                maxBlindInsns: this.maxBlindInsns, throttleDegraded: this.throttleDegraded,
                windowOpen: this.pending !== null, sliceInsns: this.sliceInsns,
                throttling: this.throttling && !this.throttleDegraded, autoEscalated: this.autoEscalated,
                giveUpDetail: this.giveUpDetail,
                ticksObserved: this.ticksObserved, pendingTrace: this.pendingTrace.slice(),
            },
            changed,
            unattributedChanges: this.unattributed.slice(),
            sample: { covers: this.sampleCovers, head: this.sampleHead, hash: "0x" + this.sampleHash.toString(16) },
            blindSpots: [
                "JS writes (our own HLE handlers) — no #PF exists for them; use trapJsWrites",
                "WASM string/memory hypercalls write through a raw pointer — wasmStringWriters(false) first",
                "guest stores inside a blind window (blind.blindInsns) — the sample is what catches those",
            ],
        };
    }

    /** Restore RW over the whole armed range and stop trapping. */
    disarm(): { disarmed: boolean } {
        if (!this.armed) return { disarmed: false };
        this.pending = null;
        const ptm = System.getInstance().process?.pageTableManager;
        const pageBase = this.base & ~(PAGE_SIZE - 1);
        const pageEnd = (this.end + PAGE_SIZE - 1) & ~(PAGE_SIZE - 1);
        ptm?.setProtection(pageBase, pageEnd - pageBase, PAGE_READWRITE);
        this.armed = false;
        this.trace = false;
        this.watch = false;
        this.throttling = false;
        Logger.log(LogCategory.SYSTEM,
            `[MemWriteTrap] disarmed; restored RW over 0x${pageBase.toString(16)}..0x${pageEnd.toString(16)}; ` +
            `${this.hits.length} write(s) recorded across ${this.faultedPages.size} page(s), ` +
            `${this.blindInsns} blind instruction(s), ${this.unattributed.length} unattributed change(s)`);
        return { disarmed: true };
    }
}

export const memWriteTrap = new MemWriteTrap();
