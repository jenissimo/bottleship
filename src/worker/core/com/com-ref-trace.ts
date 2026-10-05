/**
 * comRefs — armed AddRef/Release history, keyed by the guest-visible object address.
 *
 * A COM object that dies while the guest still holds it reports itself only as E_FAIL
 * from every method and then a NULL call through the pointer the guest kept. The refcount
 * at the moment of death answers nothing: the question is WHICH reference was never taken,
 * or taken twice, and that is a history question. Recording is OFF by default — an armed
 * entry costs a guest-stack read (and, with `jsStacks`, a captured Error) per AddRef.
 *
 * `dropped` is part of the reading: a ring that overwrote the birth of the object cannot
 * prove a balance, and it says so instead of presenting a truncated tally as a complete one.
 */
import { System } from "../system";

export type ComRefOp = "addRef" | "release" | "birth" | "zeroRef" | "forceRelease";

export interface ComRefEntry {
    seq: number;
    tMs: number;
    op: ComRefOp;
    /** Guest address the object is mapped at (0 when the handle has no mapping yet). */
    addr: number;
    handle: number;
    cls: string;
    /** Count the caller observes after the operation. */
    count: number;
    /** Interface pointer the guest called through (perInterfaceRefs objects only). */
    ifacePtr: number;
    /** [ESP] while the handler ran. For a guest-dispatched thunk this is the guest caller;
     *  for a call made by our own JS it is whatever thunk's frame we are nested inside. */
    retAtEsp: number;
    tid: number;
    /** Top JS frames — the decisive field when the missing/extra reference is OURS. */
    js?: string;
}

interface ArmOpts {
    addr?: number;
    cls?: string;
    limit?: number;
    jsStacks?: boolean;
}

let armed = false;
let opts: ArmOpts = {};
let ring: ComRefEntry[] = [];
let seq = 0;
let dropped = 0;
let limit = 8192;

export function isComRefTraceArmed(): boolean {
    return armed;
}

export function armComRefTrace(o: ArmOpts = {}): void {
    opts = o;
    limit = Math.max(64, Math.min(200_000, o.limit ?? 8192));
    ring = [];
    seq = 0;
    dropped = 0;
    armed = true;
}

export function disarmComRefTrace(): void {
    armed = false;
}

/** Guest [ESP] and thread id, or zeros when there is no live CPU to read. */
function guestSite(): { ret: number; tid: number } {
    try {
        const process = System.getInstance().process;
        const cpu = process?.v86?.cpu;
        const mem8 = process?.getCurrentMemory();
        if (!cpu || !mem8) return { ret: 0, tid: 0 };
        const esp = cpu.reg32?.[4] ?? 0;
        if (esp <= 0 || esp + 4 > mem8.length) return { ret: 0, tid: 0 };
        const view = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);
        // The scheduler hangs off System, not Process — and it is absent before the first
        // thread exists, which is exactly when an early AddRef can land.
        const scheduler = System.getInstance().scheduler as { getCurrentThreadId?: () => number } | undefined;
        return { ret: view.getUint32(esp, true) >>> 0, tid: scheduler?.getCurrentThreadId?.() ?? 0 };
    } catch {
        return { ret: 0, tid: 0 };
    }
}

function jsFrames(): string | undefined {
    if (!opts.jsStacks) return undefined;
    const raw = new Error().stack ?? "";
    return raw
        .split("\n")
        .slice(3, 9)
        .map((l) => l.trim().replace(/^at\s+/, ""))
        .join(" < ");
}

export function recordComRef(
    op: ComRefOp,
    handle: number,
    cls: string,
    count: number,
    ifacePtr: number,
    addr: number,
): void {
    if (!armed) return;
    if (opts.addr !== undefined && (addr >>> 0) !== (opts.addr >>> 0) && (ifacePtr >>> 0) !== (opts.addr >>> 0)) return;
    if (opts.cls !== undefined && !cls.toLowerCase().includes(opts.cls.toLowerCase())) return;

    const site = guestSite();
    if (ring.length >= limit) {
        ring.shift();
        dropped++;
    }
    ring.push({
        seq: seq++,
        tMs: Math.round(performance.now() * 10) / 10,
        op,
        addr: addr >>> 0,
        handle: handle >>> 0,
        cls,
        count,
        ifacePtr: ifacePtr >>> 0,
        retAtEsp: site.ret,
        tid: site.tid,
        js: jsFrames(),
    });
}

export interface ComRefReport {
    armed: boolean;
    filter: ArmOpts;
    /** Entries the ring overwrote. Non-zero means no balance below is provable. */
    dropped: number;
    kept: number;
    /** Per-address tally over the KEPT window only. */
    perAddr: Array<{
        addr: string;
        cls: string;
        addRefs: number;
        releases: number;
        net: number;
        lastCount: number;
        died: boolean;
        /** Call sites, most frequent first: "0xEIP xN". */
        addRefSites: string[];
        releaseSites: string[];
    }>;
    entries: ComRefEntry[];
}

function siteHistogram(entries: ComRefEntry[]): string[] {
    const hist = new Map<number, number>();
    for (const e of entries) hist.set(e.retAtEsp, (hist.get(e.retAtEsp) ?? 0) + 1);
    return [...hist.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([ret, n]) => `0x${ret.toString(16)} x${n}`);
}

export function comRefReport(tail = 200): ComRefReport {
    const byAddr = new Map<number, ComRefEntry[]>();
    for (const e of ring) {
        const key = e.addr || e.ifacePtr;
        const list = byAddr.get(key);
        if (list) list.push(e); else byAddr.set(key, [e]);
    }
    const perAddr = [...byAddr.entries()].map(([addr, list]) => {
        const adds = list.filter((e) => e.op === "addRef");
        const rels = list.filter((e) => e.op === "release");
        return {
            addr: "0x" + addr.toString(16),
            cls: list[list.length - 1].cls,
            addRefs: adds.length,
            releases: rels.length,
            net: adds.length - rels.length,
            lastCount: list[list.length - 1].count,
            died: list.some((e) => e.op === "zeroRef" || e.op === "forceRelease"),
            addRefSites: siteHistogram(adds),
            releaseSites: siteHistogram(rels),
        };
    }).sort((a, b) => a.net - b.net);

    return {
        armed,
        filter: opts,
        dropped,
        kept: ring.length,
        perAddr,
        entries: ring.slice(-Math.max(0, tail)),
    };
}
