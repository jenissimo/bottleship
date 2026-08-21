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
import {
    windows,
    getAbsoluteWindowPosition,
    getCurrentCursorHandle,
    getCursorDisplayCount,
    isCursorClipped,
    isGuestCursorVisible,
} from "../modules/user32/shared-state";
import { getActiveDeviceCursor, isDeviceCursorVisible } from "../core/device-cursor";
import { leaseRegistry } from "../core/memory/lease-registry";
import { memoryEventBuffer } from "../core/memory/memory-event-buffer";
import { THREAD_STATE_NAMES, WAIT_REASON_NAMES } from "../core/scheduler/types";
import { videoEngine } from "../../video/video-engine";
import { getFfmpegHleStats } from "../modules/ffmpeg/native-patch";
import { Logger, LogCategory } from "../core/logger";
import { getSurfaceFormatLayout } from "../backends/webgpu/shared/texture-formats";

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
                // WHAT the thread is blocked on, not just that it is blocked — a deadlock
                // reads as "everyone WAITING" without it, and the handles are what pair a
                // stuck waiter with whoever should have signalled.
                waitHandles: (t.waitInfo?.handles ?? []).map((h: number) => u32(h)),
                waitAll: t.waitInfo?.waitAll ?? false,
                waitCsAddress: u32(t.waitInfo?.csAddress ?? 0),
                waitTimeoutTimerId: u32(t.waitInfo?.timeoutTimerId ?? 0),
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
    // Suspend-vs-wait census: WAITING+suspendCount>0 is a legal, transient shape and a
    // point-sampled thread list cannot show whether it ever happened. These cumulative
    // counters can — `suspendOnWaiting: 0` means the suspend/wait interaction never arose.
    return {
        currentThreadId, runQueue, count: threads.length, threads,
        suspendWait: sched.suspendWaitStats ? { ...sched.suspendWaitStats } : null,
    };
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
        // The guest COM address, so a breakOnApi this-ptr can be named. Without it a
        // break snapshot's args and this list share no key and cannot be joined at all.
        let comAddr = 0;
        try { comAddr = u32(provider?.getAddressForHandle?.(o._handle ?? o.handle)); } catch { /* not registered */ }
        out.push({
            ptr: st.surfacePtr >>> 0,
            ptrHex: "0x" + (st.surfacePtr >>> 0).toString(16),
            comAddrHex: comAddr ? "0x" + comAddr.toString(16) : null,
            attachedSurfaceAddrHex: st.attachedSurfaceAddr ? "0x" + u32(st.attachedSurfaceAddr).toString(16) : null,
            // The whole attachment picture, so surface LIFETIME is inspectable: who is
            // attached to whom, which members DirectDraw owns (implicit, never counted),
            // which surface holds the one reference AddAttachedSurface takes, and the
            // resulting refcount. "The attach ref leaked" is otherwise invisible until a
            // freed COM block is dispatched through.
            attachedSurfaceAddrs: st.attachedSurfaceAddrs?.map((a: number) => "0x" + u32(a).toString(16)) ?? null,
            implicitChainMember: st.implicitChainMember ?? false,
            attachRefOwnerHex: st.attachRefOwner ? "0x" + u32(st.attachRefOwner).toString(16) : null,
            refCount: typeof o?.refCount === "number" ? o.refCount : null,
            zOwnerSurfaces: st.zOwnerSurfaces?.map((a: number) => "0x" + u32(a).toString(16)) ?? null,
            width: st.width,
            height: st.height,
            pitch: st.pitch ?? 0,
            bpp: st.format?.bpp ?? 0,
            // A DDPF_FOURCC surface carries NO bit count and no masks by contract, so bpp
            // alone renders a DXT surface indistinguishable from an RGB one in this dump —
            // and "the pitch is linear where it should be blocked" is exactly the bug shape
            // that hides there. expectedPitch is what the format's own layout demands.
            fourCC: st.format?.fourCC
                ? String.fromCharCode(
                    st.format.fourCC & 0xff, (st.format.fourCC >>> 8) & 0xff,
                    (st.format.fourCC >>> 16) & 0xff, (st.format.fourCC >>> 24) & 0xff)
                : null,
            expectedPitch: st.format
                ? getSurfaceFormatLayout(st.format, st.width, st.height).pitch
                : null,
            caps: u32(st.caps),
            surfaceType: st.surfaceType ?? null,
            mode: st.mode ?? null,
            version: st.version ?? null,
            gpuDirty: st.gpuDirty ?? null,
            lastUploadVersion: st.lastUploadVersion ?? null,
            // A source colour key changes what a Blt of this surface MEANS; without it
            // "the texture is black" and "the texture is fully keyed" look identical.
            srcColorKey: st.srcColorKey
                ? "0x" + u32(st.srcColorKey.low).toString(16) + "-0x" + u32(st.srcColorKey.high).toString(16)
                : null,
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
    const wm = sys().windowManager;
    const activeHwnd = wm.getActiveHwnd();
    const zOrder = wm.getZOrder();
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
            active: hwnd === activeHwnd,
            zIndex: zOrder.indexOf(hwnd),
            parent: w.parent ?? null,
            childCount: w.children?.length ?? 0,
            style: u32(w.style),
            customPaint: !!w.guestCustomPaint,
            // Which proc will see a message: a subclassed control's guest proc runs first
            // and reaches the class behaviour only through CallWindowProc.
            subclassed: !!w.wndProcSubclassed,
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
    // VideoEngine doesn't expose "which session is active", so the answer to "where
    // do the decoded frames actually go" lives in VideoRoutingService: the resolved
    // sink per session, the target hint the codec published, and the overlay plane's
    // own size. Without it a mis-sized or mis-routed video looks identical to a
    // decode failure from the outside.
    const routing: any = sys().videoRouting;
    return {
        loaded: !!videoEngine?.isLoaded?.(),
        routing: routing?.getDebugInfo?.() ?? null,
        // Separates "we replaced the guest's ffmpeg decode" from "we declined and it is still
        // running its own": `served` counts frames we published, `declined` calls handed back.
        ffmpegHle: getFfmpegHleStats(),
    };
}

/**
 * Guest pointer state — the whole "why is there no cursor" question in one POJO.
 * A game hides the system pointer either with SetCursor(NULL) (handle 0) or by
 * driving the display count negative, and is then expected to draw its own; the
 * shape the host renders comes from the CURSOR user object behind the handle.
 * `visible` is what the host is told, so it separates "we hid it" from "we kept
 * it but the shape never arrived".
 */
export function serializeCursor(): unknown {
    const handle = getCurrentCursorHandle();
    const obj: any = sys().resourceProvider?.getUserObject?.(handle);
    const hasPixels = obj?.type === "CURSOR"
        && obj.pixels instanceof Uint8Array
        && obj.width > 0 && obj.height > 0;
    const device = getActiveDeviceCursor();
    return {
        // What the host is actually told to draw: the D3D device cursor outranks the
        // Win32 one, so `visible: false` with a live device cursor is not a hidden pointer.
        visible: !!device || isGuestCursorVisible(),
        displayCount: getCursorDisplayCount(),
        handle,
        handleHex: "0x" + handle.toString(16),
        clipped: isCursorClipped(),
        image: hasPixels
            ? { width: obj.width, height: obj.height, hotspotX: obj.xHotspot ?? 0, hotspotY: obj.yHotspot ?? 0 }
            : null,
        objType: obj?.type ?? null,
        deviceCursor: device
            ? { width: device.width, height: device.height, hotspotX: device.hotspotX, hotspotY: device.hotspotY }
            : null,
        deviceCursorVisible: isDeviceCursorVisible(),
    };
}

/**
 * Buffered-DirectInput production trail. A DI game that ignores our synthetic input
 * looks identical from the WM side (wmTrace shows a perfect sequence) whether the
 * DI queue got the event or not — this is the other half of that question.
 */
export function serializeDInput(): unknown {
    return sys().inputManager?.getDInputDiagnostics?.() ?? null;
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
    // The CANVAS size is a separate fact from the DDraw display mode above, and a
    // mismatch is exactly the bug class that reads as "cropped/squished pixels" — so
    // report both rather than letting `width/height` stand in for "the resolution".
    const canvas: any = (sys().process as any)?.canvas;
    return {
        primaryPtr,
        primaryPtrHex: "0x" + primaryPtr.toString(16),
        /** DDraw display mode (SetDisplayMode/ChangeDisplaySettings), NOT the canvas. */
        width: w,
        height: h,
        canvasWidth: canvas?.width ?? 0,
        canvasHeight: canvas?.height ?? 0,
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

/**
 * A pointer argument decoded as text, or null. Most bring-up questions about a
 * call are "WHICH one" — which file, which resource name, which class — and the
 * answer is behind the pointer, not in the number. The stack is gone by the time
 * a script could read it back (apiBreak does not pause the guest), so decode at
 * the hit instant. ANSI first, then UTF-16LE; anything not fully printable and
 * NUL-terminated inside the window is reported as null rather than guessed at.
 */
function decodeStringArg(mem: Uint8Array | null, ptr: number): string | null {
    const p = ptr >>> 0;
    if (!mem || p < 0x1000 || p + 2 > mem.length) return null;
    const printable = (c: number): boolean => c === 9 || (c >= 0x20 && c !== 0x7f);
    const limit = Math.min(mem.length, p + 260);
    // ANSI
    let ansi = "";
    for (let a = p; a < limit; a++) {
        const c = mem[a]!;
        if (c === 0) break;
        if (!printable(c)) { ansi = ""; break; }
        ansi += String.fromCharCode(c);
    }
    if (ansi.length >= 2) return ansi;
    // UTF-16LE (mem[p+1] === 0 with a printable lead byte is the giveaway)
    let wide = "";
    for (let a = p; a + 1 < limit; a += 2) {
        const c = mem[a]! | (mem[a + 1]! << 8);
        if (c === 0) break;
        if (c > 0xff || !printable(c)) { wide = ""; break; }
        wide += String.fromCharCode(c);
    }
    if (wide.length >= 2) return wide;
    return ansi.length ? ansi : null;
}

/** Read up to 8 stack args (esp+4..esp+0x20) + return address (esp) — for apiBreak.
 *  Eight, not four: COM methods routinely take 6-7 (IDirect3D9::CreateDevice's
 *  pPresentationParameters is arg 5), and a snapshot that silently stops at 4 hands the
 *  reader a `0` that is indistinguishable from a real NULL pointer. */
const ARG_OFFSETS = [4, 8, 12, 16, 20, 24, 28, 32];

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
    // Raw window around ESP — the caller's saved registers and ITS return slot sit
    // just past the arguments, which is where stack-corruption bugs show up (a
    // clobbered return address is invisible to the symbolized backtrace, since the
    // walker skips words that don't look like code).
    const stackWords: string[] = [];
    for (let off = -8; off <= 40; off += 4) {
        stackWords.push(`[ESP${off < 0 ? "-" : "+"}0x${Math.abs(off).toString(16)}]=0x${r(off).toString(16)}`);
    }

    return {
        name,
        eip: eip >>> 0,
        eipSym: symbolize(eip),
        esp: esp >>> 0,
        caller: r(0),
        callerSym: symbolize(r(0)),
        args: ARG_OFFSETS.map(r),
        argStrings: ARG_OFFSETS.map(r).map((a) => decodeStringArg(mem, a)),
        stackWords,
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
    cursor: serializeCursor,
    dinput: serializeDInput,
};
