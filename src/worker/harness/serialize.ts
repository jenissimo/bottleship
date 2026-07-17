/**
 * Typed POJO serializers for harness.state(). Every section returns a
 * plain JSON object — no cycles, no class instances, no GPUBuffer/handle refs —
 * so one payload survives CDP returnByValue and MCP evaluate_script identically.
 *
 * These centralize the `as any` casts and the v86 cpu access idiom that are
 * scattered across the codebase. All reads are read-only (the harness observes,
 * never mutates engine state).
 */

import { System } from "../core/system";
import { HarnessError, HarnessErrorCode } from "./rpc";
import { windows, getAbsoluteWindowPosition } from "../modules/user32/shared-state";
import { leaseRegistry } from "../core/memory/lease-registry";
import { memoryEventBuffer } from "../core/memory/memory-event-buffer";
import { THREAD_STATE_NAMES, WAIT_REASON_NAMES } from "../core/scheduler/types";
import { videoEngine } from "../../video/video-engine";
import { Logger, LogCategory } from "../core/logger";

/* ───────────────────────── low-level access helpers ───────────────────────── */

export function sys(): System {
    return System.getInstance();
}

/** Process or null (null before a game loads). */
export function proc(): any {
    return System.getInstance().process ?? null;
}

/** Process, or throw a typed NO_PROCESS error. */
export function requireProc(): any {
    const p = System.getInstance().process;
    if (!p) throw new HarnessError("no process loaded (load a game first)", HarnessErrorCode.NO_PROCESS);
    return p;
}

/** The live v86 CPU view (or null). Canonical fallback chain used across the worker. */
export function cpu(): any {
    const p = proc();
    return p?.v86?.cpu ?? p?.v86?.v86?.cpu ?? null;
}

/** Guest linear memory (Uint8Array) or null. */
export function guestMem(): Uint8Array | null {
    return proc()?.getCurrentMemory?.() ?? null;
}

const u32 = (x: number | undefined): number => (x ?? 0) >>> 0;

/** A WinAPI module instance by name, or undefined. */
export function getModule(name: string): any {
    return proc()?.getModule?.(name);
}

/** Symbolize a guest linear address against loaded PE modules ("core.dll+0x.. [Func]"). */
export function symbolize(addr: number): string | null {
    try {
        return proc()?.moduleRegistry?.resolveAddress?.(addr >>> 0) ?? null;
    } catch {
        return null;
    }
}

/* ───────────────────────────── section serializers ───────────────────────── */

export function serializeCpu(): unknown {
    const c = cpu();
    if (!c) return null;
    const eip = u32(c.instruction_pointer?.[0]);
    const r = c.reg32 ?? [];
    return {
        eip,
        eipSym: symbolize(eip),
        regs: {
            eax: u32(r[0]), ecx: u32(r[1]), edx: u32(r[2]), ebx: u32(r[3]),
            esp: u32(r[4]), ebp: u32(r[5]), esi: u32(r[6]), edi: u32(r[7]),
        },
        eflags: u32(c.flags?.[0]),
        segments: c.sreg ? {
            es: u32(c.sreg[0]), cs: u32(c.sreg[1]), ss: u32(c.sreg[2]),
            ds: u32(c.sreg[3]), fs: u32(c.sreg[4]), gs: u32(c.sreg[5]),
        } : null,
        fsBase: u32(c.segment_offsets?.[4]),
    };
}

export function serializeThreads(): unknown {
    const sched: any = sys().scheduler as any;
    if (!sched) return null;
    const threadsMap: Map<number, any> | undefined = sched.threads;
    const currentThreadId: number | null = sched.currentThreadId ?? null;
    const runQueue: number[] = Array.isArray(sched.runQueue) ? [...sched.runQueue] : [];
    const liveCpu = cpu();
    const threads: unknown[] = [];
    if (threadsMap) {
        for (const [, t] of threadsMap) {
            const isRunning = t.id === currentThreadId;
            // CRITICAL: thread.context is null while RUNNING — its state lives in
            // the live CPU. Read eip/esp from the CPU for the running thread.
            const eip = isRunning ? u32(liveCpu?.instruction_pointer?.[0]) : u32(t.context?.eip);
            const esp = isRunning ? u32(liveCpu?.reg32?.[4]) : u32(t.context?.esp);
            threads.push({
                id: t.id,
                handle: u32(t.handle),
                state: t.state,
                stateName: (THREAD_STATE_NAMES as Record<number, string>)[t.state] ?? String(t.state),
                waitReason: t.waitInfo?.reason ?? null,
                waitReasonName: t.waitInfo?.reason != null ? ((WAIT_REASON_NAMES as Record<number, string>)[t.waitInfo.reason] ?? null) : null,
                eip,
                eipSym: symbolize(eip),
                esp,
                tebAddress: u32(t.tebAddress),
                suspendCount: t.suspendCount ?? 0,
                priority: t.priority ?? 0,
                running: isRunning,
            });
        }
    }
    return { currentThreadId, runQueue, count: threads.length, threads };
}

/** Enumerate all surface-like COM objects backend-agnostically (DDraw/D3D7/D3D8). */
export function serializeSurfaces(): unknown {
    const provider: any = sys().resourceProvider as any;
    const objs: any[] = provider?.getAllComObjects?.() ?? [];
    let primaryPtr = 0;
    try {
        primaryPtr = u32(getModule("ddraw")?.context?.surfaces?.primary);
    } catch { /* no ddraw */ }
    const out: unknown[] = [];
    for (const o of objs) {
        const st = o?.getState?.();
        if (!st || typeof st.surfacePtr !== "number" || typeof st.width !== "number") continue;
        out.push({
            ptr: st.surfacePtr >>> 0,
            ptrHex: "0x" + (st.surfacePtr >>> 0).toString(16),
            width: st.width,
            height: st.height,
            pitch: st.pitch ?? 0,
            bpp: st.format?.bpp ?? 0,
            caps: u32(st.caps),
            surfaceType: st.surfaceType ?? null,
            mode: st.mode ?? null,
            version: st.version ?? null,
            gpuDirty: st.gpuDirty ?? null,
            hasGpuTexture: !!st.gpuTexture,
            gpuTextureFormat: st.gpuTextureFormat ?? null,
            mipMapCount: st.mipMapCount ?? null,
            activeLeaseId: st.activeLeaseId ?? null,
            everLocked: st.everLocked ?? null,
            isPrimary: primaryPtr !== 0 && (st.surfacePtr >>> 0) === primaryPtr,
        });
    }
    return out;
}

export function serializeWindows(): unknown {
    const out: unknown[] = [];
    for (const [hwnd, w] of windows) {
        const abs = getAbsoluteWindowPosition(w);
        const width = w.width ?? 0, height = w.height ?? 0;
        out.push({
            hwnd: hwnd >>> 0,
            title: w.title ?? "",
            cls: w.systemControlClass || w.nativeClassName || (w.children?.length ? "window" : ""),
            controlId: w.controlId ?? null,
            x: abs.x, y: abs.y, w: width, h: height,
            cx: abs.x + (width >> 1), cy: abs.y + (height >> 1),
            visible: !!w.visible,
            parent: w.parent ?? null,
            childCount: w.children?.length ?? 0,
            style: u32(w.style),
            customPaint: !!w.guestCustomPaint,
        });
    }
    return out;
}

export function serializeMemory(): unknown {
    const regions: any[] = proc()?.addressSpace?.getRegions?.() ?? [];
    return regions.map((r) => ({
        id: r.id,
        base: r.base >>> 0,
        baseHex: "0x" + (r.base >>> 0).toString(16),
        size: r.size,
        end: (r.base + r.size) >>> 0,
        perms: r.perms,
        kind: r.kind,
        owner: r.owner ?? null,
        tag: r.tag ?? null,
    }));
}

export function serializeRings(count = 64): unknown {
    const dispatcher: any = proc()?.dispatcher as any;
    let winApiCalls: unknown[] = [];
    try {
        winApiCalls = dispatcher?.getLastWinApiCallsRich?.(count) ?? [];
    } catch { /* best-effort */ }
    return {
        winApiCalls,
        memoryEvents: memoryEventBuffer.getRecent(count),
        leases: leaseRegistry.getActiveLeases(),
    };
}

export function serializeModules(): unknown {
    const mr: any = proc()?.moduleRegistry as any;
    const mods: any[] = mr?.getAllModules?.() ?? [];
    return mods.map((m) => ({
        name: m.name,
        base: m.baseAddress >>> 0,
        baseHex: "0x" + (m.baseAddress >>> 0).toString(16),
        size: m.size,
        entryPoint: u32(m.entryPoint),
        isRealDll: !!m.isRealDll,
        isExecutable: !!m.isExecutable,
        initialized: !!m.initialized,
        exportCount: m.exports?.size ?? 0,
    }));
}

export function serializeAudio(): unknown {
    const ds: any = getModule("dsound");
    return {
        dsound: ds?.getAudioDebugState?.() ?? null,
    };
}

export function serializeVideo(): unknown {
    // VideoEngine doesn't expose "which session is active"; report load state and
    // let callers drill into a specific handle via the video.info verb.
    return { loaded: !!videoEngine?.isLoaded?.() };
}

export function serializeScreen(): unknown {
    let primaryPtr = 0, w = 0, h = 0;
    try {
        const ctx = getModule("ddraw")?.context;
        primaryPtr = u32(ctx?.surfaces?.primary);
        w = ctx?.display?.width ?? 0;
        h = ctx?.display?.height ?? 0;
    } catch { /* */ }
    const render: any = sys().services?.render;
    return {
        primaryPtr,
        primaryPtrHex: "0x" + primaryPtr.toString(16),
        width: w,
        height: h,
        presenter: render?.getLastPresenterKind?.() ?? null,
        presentSerial: render?.getPresentSerial?.() ?? 0,
    };
}

/**
 * Fault-grade snapshot — the same shape the WASM-trap handler builds
 * (emulator.worker.ts), reused for breakpoint hits and run-abort captures.
 * eip(+symbol), regs, 24 bytes at eip, stack window, last-30 WinAPI
 * calls, thread table.
 */
export function faultSnapshot(): unknown {
    const c = cpu();
    const mem = guestMem();
    const eip = u32(c?.instruction_pointer?.[0]);
    const esp = u32(c?.reg32?.[4]);
    let bytes = "";
    if (mem && eip + 24 <= mem.length) {
        bytes = Array.from(mem.subarray(eip, eip + 24)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    }
    const stack: string[] = [];
    if (mem && c?.reg32 && esp >= 16 && esp + 32 <= mem.length) {
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = -2; i < 6; i++) stack.push(`[ESP${i < 0 ? i * 4 : "+" + i * 4}]=0x${(dv.getUint32(esp + i * 4, true) >>> 0).toString(16)}`);
    }
    const dispatcher: any = proc()?.dispatcher as any;
    const recent = dispatcher?.getLastWinApiCalls?.(30) ?? [];
    // Flight recorder: the log-ring tail leading INTO the fault — high-signal for
    // hangs (which emit no error) and crashes alike, without streaming the firehose.
    const logTail = Logger.getRecentEntries(40).map((e) => ({
        t: e.timestamp,
        category: (LogCategory as any)[e.category] ?? String(e.category),
        level: e.level,
        message: e.message,
    }));
    return { eip, eipSym: symbolize(eip), esp, bytes, stack, recent, logTail, cpu: serializeCpu(), threads: serializeThreads() };
}

/** Read up to 4 stack args (esp+4..esp+0x10) + return address (esp) — for apiBreak. */
export function readCallSnapshot(name: string, eip: number, esp: number): unknown {
    const mem = guestMem();
    const r = (off: number): number => {
        if (!mem || esp + off + 4 > mem.length) return 0;
        return new DataView(mem.buffer, mem.byteOffset, mem.byteLength).getUint32((esp + off) >>> 0, true) >>> 0;
    };
    let threadId = 0;
    try { threadId = (sys().scheduler as any)?.getCurrentThreadId?.() ?? 0; } catch { /* */ }
    // Deep module-labelled backtrace captured synchronously at the hit instant —
    // so breakOnApi('kernel32:ExitProcess') answers "who called exit" even though
    // the call doesn't pause and the late shutdown logs get dropped in teardown.
    let backtrace: unknown[] = [];
    let recent: string[] = [];
    try {
        const bt = (proc()?.dispatcher as any)?.getGuestCallStack?.(esp >>> 0);
        if (bt?.recent) recent = bt.recent;
        if (bt?.frames) {
            backtrace = bt.frames.map((f: any) => ({
                i: f.index,
                ret: "0x" + (f.retAddr >>> 0).toString(16),
                mod: f.moduleName ? `${f.moduleName}+0x${(f.moduleOffset >>> 0).toString(16)}` : null,
                sym: symbolize(f.retAddr),
                isThunk: f.isThunk,
            }));
        }
    } catch { /* */ }
    let es = -1;
    let regs: Record<string, number> | undefined;
    try {
        const c = cpu() as any;
        if (c?.sreg) es = c.sreg[0] & 0xffff;
        // General-purpose regs at the hit instant — many WA methods are register-based
        // (this=ESI/ECX, index=EDI), so the caller-of-interest's context often lives here.
        if (c?.reg32) {
            regs = {
                eax: c.reg32[0] >>> 0, ecx: c.reg32[1] >>> 0, edx: c.reg32[2] >>> 0, ebx: c.reg32[3] >>> 0,
                esp: c.reg32[4] >>> 0, ebp: c.reg32[5] >>> 0, esi: c.reg32[6] >>> 0, edi: c.reg32[7] >>> 0,
            };
        }
    } catch { /* */ }
    return {
        name,
        eip: eip >>> 0,
        eipSym: symbolize(eip),
        esp: esp >>> 0,
        caller: r(0),
        callerSym: symbolize(r(0)),
        args: [r(4), r(8), r(12), r(16)],
        threadId,
        es,
        regs,
        lastThunks: recent,
        backtrace,
    };
}

/** Map of section name -> serializer for harness.state(sections). */
export const STATE_SECTIONS: Record<string, () => unknown> = {
    cpu: serializeCpu,
    threads: serializeThreads,
    surfaces: serializeSurfaces,
    windows: serializeWindows,
    memory: serializeMemory,
    rings: serializeRings,
    modules: serializeModules,
    audio: serializeAudio,
    video: serializeVideo,
    screen: serializeScreen,
};
