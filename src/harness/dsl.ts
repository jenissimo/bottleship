/**
 * Fluent harness DSL. A chainable async builder: each verb enqueues a
 * step; `.run()` executes them in order via the injected executor and returns one
 * accumulated POJO. A thrown assertion (an expect* step the worker rejects)
 * aborts the chain and the executor auto-captures a fault snapshot.
 *
 * The builder is pure sugar over the step list — the SAME builder works in the
 * browser console (executor = facade.__runSteps) and in the CLI (executor ships
 * the steps to the page over CDP). Predicate functions (waitUntil) are serialized
 * to source so they can be evaluated inside the worker.
 */

import type { HarnessStep, HarnessRunResult } from "./types";
import { stepsToScript } from "./journal";

export type StepExecutor = (steps: HarnessStep[]) => Promise<HarnessRunResult>;

/** Replace function args with {__fn:source} markers so they survive transport
 *  and are reconstructed/evaluated in the worker. */
function ser(args: unknown[]): unknown[] {
    return args.map((a) => (typeof a === "function" ? { __fn: a.toString() } : a));
}

export class HarnessChain {
    private steps: HarnessStep[] = [];
    constructor(private readonly exec: StepExecutor) {}

    /** Generic escape hatch: enqueue any worker command. */
    call(cmd: string, ...args: unknown[]): this {
        this.steps.push({ cmd, args: ser(args) });
        return this;
    }
    private push(cmd: string, args: unknown[], label?: string): this {
        this.steps.push({ cmd, args: ser(args), label });
        return this;
    }
    /** Push a step with an explicit RPC timeout (long/unbounded waits — so the
     *  default 60s RPC envelope doesn't pre-empt the verb's own deadline). */
    private pushTimed(cmd: string, args: unknown[], timeoutMs: number): this {
        this.steps.push({ cmd, args: ser(args), opts: { timeoutMs } });
        return this;
    }

    // ── lifecycle / loading (browser-only handled by the facade) ──
    /** Hard-reload ?game=dev before subsequent steps (CDP-side; safe in .run() chains). */
    reload(): this { return this.push("reload", []); }
    /** Load a WGB. By default reloads the page first (fresh worker + code); pass `{ reload: false }` to skip. */
    openWgb(idOrUrl: string, opts?: { hle?: boolean; logOnly?: boolean; reload?: boolean }): this {
        const reload = opts?.reload !== false;
        if (reload) this.push("reload", []);
        return this.push("openWgb", [idOrUrl, { ...opts, reload: false }]);
    }
    loadPe(url: string): this { return this.push("loadPe", [url]); }
    audioGesture(): this { return this.push("audioGesture", []); }

    // ── logging ──
    streamLogs(categories?: string[]): this { return this.push("streamLogs", [categories]); }
    /** Stop shipping log batches to the sidecar. **Bracket every measured window with this**:
     *  streaming costs real time on the WORKER thread — the exact thread a perf window is
     *  measuring — and its volume varies with what the guest happens to log, so it adds bias
     *  as well as noise. The in-memory ring keeps filling, so `logs`/`logsSince`/`report`
     *  still work; only the postMessage + WS shipping stops. Re-arm with `streamLogs()`. */
    stopLogs(): this { return this.push("stopLogs", []); }
    logs(count?: number, filter?: string): this { return this.push("logs", [count, filter]); }
    /** Widen the in-memory log ring (default 50) BEFORE a repro so the tail that led to a
     *  fault is still there when `logs`/`report` run. Resizing clears the ring. */
    logRing(size: number): this { return this.push("logRing", [size]); }
    logStats(count?: number, top?: number): this { return this.push("logStats", [count, top]); }
    markLog(label: string): this { return this.push("markLog", [label]); }
    logsSince(label: string, opts?: { filter?: string; count?: number }): this { return this.push("logsSince", [label, opts]); }
    watchLog(pattern: string, opts?: { once?: boolean }): this { return this.push("watchLog", [pattern, opts]); }
    logAgg(on = true): this { return this.push("logAgg", [on]); }
    logAggStats(top?: number): this { return this.push("logAggStats", [top]); }

    // ── waits / determinism ──
    waitForEvent(name: string, opts?: { timeoutMs?: number }): this { return this.push("waitForEvent", [name, opts]); }
    /** onModal(pattern?, reply?) — auto-answer MessageBox prompts (default: any → "ok")
     *  so unattended runs don't wedge on a modal that parks the guest thread. */
    onModal(pattern?: string, reply?: number | string): this { return this.push("onModal", [pattern ?? ".*", reply ?? "ok"]); }
    // These can run >60s; give the RPC envelope a deadline derived from the verb's
    // own (so the default 60s timeout doesn't spuriously abort long bring-up waits).
    waitUntil(predicate: () => boolean, opts?: { timeoutMs?: number; pollMs?: number }): this { return this.pushTimed("waitUntil", [predicate, opts], (opts?.timeoutMs ?? 30_000) + 5_000); }
    tickFrames(n: number, opts?: { timeoutMs?: number; park?: boolean }): this { return this.pushTimed("tickFrames", [n, { park: opts?.park }], opts?.timeoutMs ?? 120_000); }
    watchFrames(on = true): this { return this.push("watchFrames", [on]); }
    sleep(ms: number): this { return this.pushTimed("sleep", [ms], ms + 5_000); }

    // ── input ──
    click(target: string | number): this { return this.push("click", [target]); }
    /** Click at guest-pixel coordinates (DDraw/D3D-composed UIs with no Win32 controls to target by label). */
    clickAt(x: number, y: number, button?: number): this { return this.push("clickAt", [x, y, button]); }
    /** Host-side snapshot of the published input record (the other half of state(["input"])). */
    inputSab(): this { return this.push("inputSab", []); }
    /** Press + hold at guest coords, release on a timer — for low-fps state-polling guests that miss a synchronous click. */
    clickHold(x: number, y: number, holdMs?: number, button?: number): this { return this.push("clickHold", [x, y, holdMs, button]); }
    key(vk: number | string, opts?: { down?: boolean; up?: boolean }): this { return this.push("key", [vk, opts]); }
    /** Press + hold a key across real frames, release on a timer — the keyboard twin of
     *  clickHold. A synchronous key tap is invisible to low-fps state-polling guests
     *  (DirectInput/GetAsyncKeyState) — use this for game menus (e.g. NFSU). */
    keyHold(vk: number | string, holdMs = 350): this { return this.push("keyHold", [vk, holdMs]); }
    type(text: string): this { return this.push("type", [text]); }
    move(x: number, y: number): this { return this.push("move", [x, y]); }
    drag(x0: number, y0: number, x1: number, y1: number, button?: number): this { return this.push("drag", [x0, y0, x1, y1, button]); }
    wheel(x: number, y: number, delta: number): this { return this.push("wheel", [x, y, delta]); }
    /** Plug (true) or unplug (false) the gamepad: drives the SAB presence slot through the
     *  normal poll, so the guest gets the real WM_DEVICECHANGE / DIERR_INPUTLOST sequence. */
    padPlug(connected = true): this { return this.push("padPlug", [connected]); }
    /** Record the pointer/keyboard WM_* the input layer posts — the ring expectMessages asserts over. */
    wmTrace(action: "start" | "stop" | "read" | "clear" = "read"): this { return this.push("wmTrace", [action]); }

    // ── touch (CDP-side: device emulation + synthetic contacts; coords are GUEST px) ──
    /** Emulate a device profile — 'phone-landscape' | 'tablet-landscape' | 'desktop' (clears the override) — before the touch verbs. */
    device(profile: string): this { return this.push("device", [profile]); }
    tap(x: number, y: number): this { return this.push("tap", [x, y]); }
    /** One contact along a line over `ms`, with interpolated moves so a recognizer sees a real motion trail. */
    touchDrag(x0: number, y0: number, x1: number, y1: number, ms?: number): this { return this.push("touchDrag", [x0, y0, x1, y1, ms]); }
    /** Contact held for `ms` of REAL time — the RMB gesture. */
    longPress(x: number, y: number, ms?: number): this { return this.push("longPress", [x, y, ms]); }
    twoFingerTap(x: number, y: number, spread?: number): this { return this.push("twoFingerTap", [x, y, spread]); }
    /** Two contacts straddling (x,y) moving symmetrically to `scale`× their span (<1 in, >1 out). */
    pinch(x: number, y: number, scale: number, ms?: number): this { return this.push("pinch", [x, y, scale, ms]); }

    // ── observe ──
    state(sections?: string[]): this { return this.push("state", [sections]); }
    /** On-demand guest call-stack (module-labelled). Pair with breakOnApi('kernel32:ExitProcess') to see who called exit. */
    backtrace(esp?: number): this { return this.push("backtrace", [esp]); }
    /** Deduplicated registry of UNIMPLEMENTED thunks the guest called (id + count + caller). Firehose-immune stub finder. */
    stubs(): this { return this.push("stubs", []); }
    /** Runtime API coverage: GetProcAddress resolutions (and what each ACTUALLY resolved to),
     *  COM/vtable calls, silent stubs — the half `bun tools/api-census.ts` cannot see statically. */
    apiCoverage(limit?: number): this { return this.push("apiCoverage", [limit]); }
    /** One-shot incident report: cpu + backtrace + last thunks + stubs + faults + threads. The go-to for ANY anomaly (freeze/crash/exit/black frame). */
    report(esp?: number): this { return this.push("report", [esp]); }
    /** Recent guest page faults (EIP / fault addr / thread / last thunk / regs). */
    faults(n?: number): this { return this.push("faults", [n]); }
    /** Raw guest memory as hex — read a struct, a stack frame, or unpacked code. */
    readBytes(addr: number | string, len?: number): this { return this.push("readBytes", [addr, len]); }
    shot(opts?: { save?: string }): this { return this.push("shot", [opts]); }
    captureFrame(opts?: { dumpTargets?: boolean }): this { return this.push("captureFrame", [opts]); }
    textures(): this { return this.push("textures", []); }
    dumpTexture(sel: string | { stage: number }): this { return this.push("dumpTexture", [sel]); }
    dumpSurface(sel: string): this { return this.push("dumpSurface", [sel]); }
    /** One COMPLETED GL frame, decoded per draw: drawable size, the viewport/scissor that
     *  were active, and each draw's NDC + resulting screen box. Separates "wrong quad" from
     *  "wrong viewport/render target" without guessing. */
    glFrame(opts?: { timeoutMs?: number }): this { return this.push("glFrame", [opts]); }
    glTextures(): this { return this.push("glTextures", []); }
    glDumpTexture(id: number): this { return this.push("glDumpTexture", [id]); }

    // ── perf (frame profiler / worst-frames, POJO equivalent of the System Profiler) ──
    /** Arm (default) / disarm + optionally reset the worker frame profiler. */
    perfProfile(opts?: { enable?: boolean; reset?: boolean }): this { return this.push("perfProfile", [opts]); }
    /** Worst frames (frameMs desc) with category + hottest-thunk breakdown — names the cause of a stall. */
    perfSpikes(opts?: { top?: number; minMs?: number }): this { return this.push("perfSpikes", [opts]); }
    /** Latest + average frame sample + spike count. */
    perfStats(): this { return this.push("perfStats", []); }
    /** Named-bucket sub-phase timings (avg/total/max/count). filter by substring; maxMs = worst single call. */
    profilerStats(opts?: { filter?: string; top?: number; sort?: "max" | "total" | "avg" }): this { return this.push("profilerStats", [opts]); }

    // ── time ──
    time(action: "freeze" | "advance" | "realtime", ms?: number): this { return this.push("time", [action, ms]); }

    // ── breakpoints / exec control ──
    // Breakpoints block until hit — unbounded RPC envelope (the CLI's CDP budget /
    // an explicit clearBreaks bounds them). Pass {continuous:true} to return at once.
    breakOn(eip: number | string, opts?: { continuous?: boolean; pause?: boolean }): this { return this.pushTimed("breakOn", [eip, opts], 0); }
    breakOnExport(name: string, opts?: { continuous?: boolean; pause?: boolean }): this { return this.pushTimed("breakOnExport", [name, opts], 0); }
    breakOnSymbol(name: string, opts?: { continuous?: boolean; pause?: boolean }): this { return this.pushTimed("breakOnSymbol", [name, opts], 0); }
    /** `argEq` breaks only when a stack argument matches — the way to hit ONE call of a hot API. */
    breakOnApi(pattern: string, opts?: { continuous?: boolean; argEq?: { index: number; value: number } }): this { return this.pushTimed("breakOnApi", [pattern, opts], 0); }
    watchMem(addr: number | string, opts?: { onWrite?: boolean }): this { return this.push("watchMem", [addr, opts]); }
    pause(): this { return this.push("pause", []); }
    resume(): this { return this.push("resume", []); }

    // ── record / replay (present-serial gated; harness-injected input only) ──
    record(): this { return this.push("record", []); }
    recordStop(): this { return this.push("recordStop", []); }
    replay(recording: unknown): this { return this.pushTimed("replay", [recording], 0); }

    // ── host record / replay (captures MANUAL play: the human's SAB publications) ──
    hostRecord(): this { return this.push("hostRecord", []); }
    hostRecordStop(): this { return this.push("hostRecordStop", []); }
    hostReplay(samples: unknown, opts?: { deterministic?: boolean }): this { return this.pushTimed("hostReplay", [samples, opts], 0); }

    // ── filesystem / registry ──
    fsRead(path: string): this { return this.push("fsRead", [path]); }
    fsWrite(path: string, content: string, opts?: { encoding?: "utf8" | "base64" }): this { return this.push("fsWrite", [path, content, opts]); }
    fsDelete(path: string): this { return this.push("fsDelete", [path]); }
    fsList(path: string): this { return this.push("fsList", [path]); }
    fsStat(path: string): this { return this.push("fsStat", [path]); }
    fsFlush(): this { return this.push("fsFlush", []); }
    regGet(root: string, key: string, value?: string): this { return this.push("regGet", [root, key, value]); }

    // ── OPFS container fixtures (keyed by container; usable before a bundle loads) ──
    containerList(container: string): this { return this.push("containerList", [container]); }
    containerRead(container: string, path: string): this { return this.push("containerRead", [container, path]); }
    containerWrite(container: string, path: string, base64: string): this { return this.push("containerWrite", [container, path, base64]); }
    containerDelete(container: string, path?: string): this { return this.push("containerDelete", [container, path]); }

    // ── assertions (worker rejects -> chain aborts) ──
    expect(cmd: string, ...args: unknown[]): this { return this.push(cmd, args); }
    expectDialog(title: string): this { return this.push("expectDialog", [title]); }
    expectSurfaceNonBlack(sel?: string): this { return this.push("expectSurfaceNonBlack", [sel]); }
    expectThread(opts: { state?: string; eip?: number }): this { return this.push("expectThread", [opts]); }
    expectFileExists(path: string): this { return this.push("expectFileExists", [path]); }
    /** Ordered SUBSEQUENCE over the wmTrace ring. Patterns: 'WM_MOUSEMOVE@400,300',
     *  'WM_KEYDOWN vk=0x57', 'WM_KEYDOWN vk=0x57 repeat'. */
    expectMessages(patterns: string[]): this { return this.push("expectMessages", [patterns]); }

    /** Execute the chain; returns one accumulated POJO. */
    run(): Promise<HarnessRunResult> {
        return this.exec(this.steps);
    }

    /** The recorded steps (for journaling / inspection). */
    toSteps(): HarnessStep[] {
        return [...this.steps];
    }

    /** Emit this chain as a re-runnable *.harness.ts source. */
    toScript(header?: string): string {
        return stepsToScript(this.steps, { header });
    }
}
