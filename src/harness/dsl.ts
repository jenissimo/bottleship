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
    /** Evaluate an expression in the PAGE and return its value (CDP-side). For assertions that
     *  need the composited canvas itself — `shot` hands back a PNG, not pixels. */
    evalPage(expr: string, timeoutMs?: number): this { return this.push("evalPage", [expr, timeoutMs]); }
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
     *  so unattended runs don't wedge on a modal that parks the guest thread. Armed
     *  answers survive openWgb()'s reload — and therefore later runs in the same tab. */
    onModal(pattern?: string, reply?: number | string): this { return this.push("onModal", [pattern ?? ".*", reply ?? "ok"]); }
    /** Disarm every auto-answer, so prompts reach the modal (or the assertion) again. */
    clearModals(): this { return this.push("clearModals", []); }
    /** Answer the MessageBox already on screen (onModal only pre-arms). */
    dismissModal(button: number | string = "ok", required = true): this { return this.push("dismissModal", [button, required]); }
    // These can run >60s; give the RPC envelope a deadline derived from the verb's
    // own (so the default 60s timeout doesn't spuriously abort long bring-up waits).
    waitUntil(predicate: () => boolean, opts?: { timeoutMs?: number; pollMs?: number }): this { return this.pushTimed("waitUntil", [predicate, opts], (opts?.timeoutMs ?? 30_000) + 5_000); }
    tickFrames(n: number, opts?: { timeoutMs?: number; park?: boolean }): this { return this.pushTimed("tickFrames", [n, { park: opts?.park }], opts?.timeoutMs ?? 120_000); }
    watchFrames(on = true): this { return this.push("watchFrames", [on]); }
    sleep(ms: number): this { return this.pushTimed("sleep", [ms], ms + 5_000); }

    // ── input ──
    click(target: string | number): this { return this.push("click", [target]); }
    /** Block until a control exists and is visible, then describe it. THE gate for a Win32
     *  front-end: its dialogs run before the render device presents, so tickFrames there
     *  waits on presents that never come and reads exactly like a hang. */
    waitForControl(target: string | number, opts?: { timeoutMs?: number; pollMs?: number; visible?: boolean }): this {
        return this.pushTimed("waitForControl", [target, opts], (opts?.timeoutMs ?? 120_000) + 10_000);
    }
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
    /**
     * Relative pointer motion, leaving the ABSOLUTE pointer where it is — the worker-side
     * twin of the host's Pointer Lock delta path, and the only way to steer a guest that
     * owns its own cursor (Quake3/DirectInput menus, mouse-look). `move`/`clickAt` say
     * nothing about where such a cursor sits, so a click there is a silent no-op; check
     * `relativeMouse` in any pointer verb's result to know you are in that world. Read the
     * cursor back off a `shot` — its position is the guest's, not ours.
     */
    moveRelative(dx: number, dy: number): this { return this.push("moveRelative", [dx, dy]); }
    /** Press WITHOUT moving, at the pointer's published position — the click half of
     *  driving a relative cursor (clickAt would inject a delta and move it off the item). */
    clickHere(holdMs = 200, button = 0): this { return this.push("clickHere", [holdMs, button]); }
    /** Sniff what the GUEST reads from the input layer: DInput drains, wheel consumption,
     *  button transitions, pressed-VK changes. Answers WHICH mechanism a title samples. */
    inputTrace(action: "start" | "stop" | "read" | "clear" = "read"): this { return this.push("inputTrace", [action]); }
    drag(x0: number, y0: number, x1: number, y1: number, button?: number): this { return this.push("drag", [x0, y0, x1, y1, button]); }
    wheel(x: number, y: number, delta: number): this { return this.push("wheel", [x, y, delta]); }
    /** Plug (true) or unplug (false) the gamepad: drives the SAB presence slot through the
     *  normal poll, so the guest gets the real WM_DEVICECHANGE / DIERR_INPUTLOST sequence. */
    padPlug(connected = true): this { return this.push("padPlug", [connected]); }
    /** Engage/release Pointer Lock (CDP-side: needs user activation + a focused tab, which
     *  no page-side verb can grant). The gate for every relative-mouse behaviour: honored
     *  SetCursorPos warps, DirectInput deltas, and the host-drawn cursor. */
    pointerLock(engage = true): this { return this.push("pointerLock", [engage]); }
    /** Record the pointer/keyboard WM_* the input layer posts — the ring expectMessages asserts over. */
    wmTrace(action: "start" | "stop" | "read" | "clear" = "read"): this { return this.push("wmTrace", [action]); }
    /** THE instrument for a BLANK control / an unpainted dialog: records every link of the
     *  paint chain (posted → pump filter → dispatched → BeginPaint/EndPaint → owner-draw
     *  chain + its task counts) with the REASON each link bailed, so "never posted",
     *  "filtered out", "flushed nothing" and "chain ran with 0 tasks" stop looking alike.
     *  Optional `hwnds` also admits non-paint messages for those windows. */
    paintTrace(action: "start" | "stop" | "read" | "clear" = "read", hwnds?: number[]): this {
        return this.push("paintTrace", [action, hwnds]);
    }

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
    /** Guest-code invalidation COVERAGE (the gate only checks ownership): pages of
     *  executable memory whose bytes changed without a covering invalidateGuestCode since
     *  the previous sweep. First call arms + baselines; call it between tickFrames batches
     *  to bracket a suspect write in time. Positive control: `setWorkerFlag('__noCodeInvalidate', true)`
     *  must make it light up. */
    codeAudit(opts?: { dump?: boolean; kinds?: string[]; wholeImage?: boolean }): this { return this.push("codeAudit", [opts]); }
    /** Recent guest page faults (EIP / fault addr / thread / last thunk / regs). */
    faults(n?: number): this { return this.push("faults", [n]); }
    /** Raw guest memory as hex — read a struct, a stack frame, or unpacked code. */
    readBytes(addr: number | string, len?: number): this { return this.push("readBytes", [addr, len]); }
    /** PNG of the SCREEN (canvas, overlays composited). `source:'layer'` asks for the
     *  presenter's pre-composite game layer instead — labelled `composited:false`. */
    shot(opts?: { save?: string; source?: "screen" | "layer" }): this { return this.push("shot", [opts]); }
    /** Our screen vs a NATIVE Windows capture, per pixel, over named regions. The reference
     *  is palette-remapped first (the demos are the classic CODE path but not the classic
     *  colour scheme); unmapped reference pixels are counted, not silently skipped. Reports
     *  a diff count and bounding box per region — WHERE, not just whether. */
    compareReference(opts: {
        url: string;
        at: { x: number; y: number };
        palette: [string, string][];
        regions?: { name: string; x: number; y: number; w: number; h: number }[];
        ignore?: { x: number; y: number; w: number; h: number }[];
        save?: string;
    }): this { return this.push("compareReference", [opts]); }
    /** Stable digest of a screen rect — the A -> B -> A identity check needs no reference. */
    screenRegionHash(rect: { x: number; y: number; w: number; h: number }): this {
        return this.push("screenRegionHash", [rect]);
    }
    /** Snapshot the screen for a later screenChangeSince() per-pixel compare. */
    screenMark(): this { return this.push("screenMark", []); }
    /** WHICH pixels changed since screenMark(). `allow` names the rects that were
     *  SUPPOSED to repaint: `outside.changed` is the scope finding, and each allow
     *  rect's own count is the positive control that the transition happened at all. */
    screenChangeSince(opts?: {
        allow?: { name?: string; x: number; y: number; w: number; h: number }[];
        within?: { x: number; y: number; w: number; h: number };
    }): this { return this.push("screenChangeSince", [opts]); }
    /** One-frame per-draw capture. `backend` ("ddraw"|"d3d8"|"d3d9") pins WHICH render path's
     *  frame boundary ends it — without it, a title where two paths present returns the other
     *  path's empty frame and that reads exactly like "no draws happened". `dumpTargets` adds
     *  the distinct render attachments the frame drew into. */
    captureFrame(opts?: { dumpTargets?: boolean; backend?: "ddraw" | "d3d8" | "d3d9"; timeoutMs?: number }): this { return this.push("captureFrame", [opts]); }
    /** Flip one render-backend DebugFlag (alpha test/blend, z test, texture resync, converter
     *  debug colours...). The first toggle that makes an invisible draw appear names the stage
     *  that was dropping it. Omit `name` to read the currently-armed flags. Sticky — clear them. */
    gpuToggle(name?: string, enabled?: boolean, value?: number): this { return this.push("gpuToggle", [name, enabled, value]); }
    textures(): this { return this.push("textures", []); }
    dumpTexture(sel: string | { stage: number }): this { return this.push("dumpTexture", [sel]); }
    dumpSurface(sel: string): this { return this.push("dumpSurface", [sel]); }
    /** One COMPLETED GL frame, decoded per draw: drawable size, the viewport/scissor that
     *  were active, and each draw's NDC + resulting screen box. Separates "wrong quad" from
     *  "wrong viewport/render target" without guessing. */
    glFrame(opts?: { timeoutMs?: number }): this { return this.push("glFrame", [opts]); }
    glTextures(): this { return this.push("glTextures", []); }
    glDumpTexture(id: number): this { return this.push("glDumpTexture", [id]); }

    // ── GPU device loss ──
    /** Destroy the live GPUDevice on purpose — the same path a real `deviceLost` takes.
     *  Waits for recovery and returns before/during/after state (`during` is sampled inside
     *  the invalidation fan-out, the one instant the guest is told the device is lost). */
    gpuLoseDevice(): this { return this.pushTimed("gpuLoseDevice", [], 30_000); }
    /** Device status/generation plus what TestCooperativeLevel and IsLost would answer now. */
    gpuDeviceState(): this { return this.push("gpuDeviceState", []); }

    // ── perf (frame profiler / worst-frames, POJO equivalent of the System Profiler) ──
    /** Arm (default) / disarm + optionally reset the worker frame profiler. */
    perfProfile(opts?: { enable?: boolean; reset?: boolean }): this { return this.push("perfProfile", [opts]); }
    /** Worst frames (frameMs desc) with category + hottest-thunk breakdown — names the cause of a stall. */
    perfSpikes(opts?: { top?: number; minMs?: number }): this { return this.push("perfSpikes", [opts]); }
    /** Latest + average frame sample, spike counts, and the frame-time tail summary. */
    perfStats(): this { return this.push("perfStats", []); }
    /** THE frame instrument: distribution tail (p50/p95/p99 + frames over BUDGET, never a
     *  hardcoded 16.7) + budget-missing frames coalesced into ranked classes with one
     *  representative each + window counter deltas (scheduler / fastmem-JIT / hypercalls) +
     *  a cross-check against the independent flip-cadence instrument + the trace join seam.
     *  A window that was not really measured returns a STATE, never percentiles.
     *  Flow: frameReport({reset:true, budgetMs:33.34}) -> play -> frameReport(). */
    frameReport(opts?: { budgetMs?: number; refreshMs?: number; top?: number; reset?: boolean; maxBuckets?: number }): this {
        return this.push("frameReport", [opts]);
    }
    /** WHICH GUEST CODE is hot, by two independent channels: sampled EIPs (time-weighted,
     *  resolved to module+rva) and trace2 block census (count-weighted, exec x instructions).
     *  A disagreement between them is reported, not reconciled. The counted channel zeroes and
     *  arms the recorder itself and publishes the window it covers, or refuses — it never ranks
     *  counters of unknown age. Arming SLOWS the guest, so take timings from a clean window.
     *  Split the window by hand with {phase:'arm'} ... {phase:'read'}. */
    guestBlocks(opts?: {
        ms?: number; intervalMs?: number; top?: number;
        phase?: "arm" | "read"; maxPages?: number; keepArmed?: boolean;
    }): this {
        return this.pushTimed("guestBlocks", [opts], (opts?.phase ? 0 : (opts?.ms ?? 2000)) + 30_000);
    }
    /** Emit the `bottleship.hotblocks` mark inside an active trace so analyze-trace can resolve
     *  wasm frames to module:rva. `harness trace` does this for you. */
    hotBlocksMark(opts?: { ms?: number; intervalMs?: number }): this {
        return this.pushTimed("hotBlocksMark", [opts], (opts?.ms ?? 3000) + 30_000);
    }
    /** Session-wide per-thunk cost (totalMs / avgUs / msPerFrame / share of the thunk slice).
     *  Use this — not FPS — to A/B one thunk's cost; per-call figures tolerate CPU contention. */
    perfThunks(opts?: { top?: number; filter?: string }): this { return this.push("perfThunks", [opts]); }
    /** Invoke a `dbg.*` command and return its value as the step result (rstats, fstats, …). */
    dbgCall(name: string, ...args: unknown[]): this { return this.push("dbgCall", [name, ...args]); }
    /** Per-draw CPU breakdown inside the ddraw draw path (resolve / prepare / vconvert /
     *  ringup / submit / tail) — the phase attribution behind a fat DrawPrimitive thunk.
     *  Off by default and zero-cost while off; measurement itself costs ~0.1-0.2ms/frame.
     *  Flow: drawCost({enable:true, reset:true}) -> play/tickFrames -> drawCost(). */
    drawCost(opts?: { enable?: boolean; reset?: boolean }): this { return this.push("drawCost", [opts]); }
    /** Named-bucket sub-phase timings (avg/total/max/count). filter by substring; maxMs = worst single call. */
    profilerStats(opts?: { filter?: string; top?: number; sort?: "max" | "total" | "avg" }): this { return this.push("profilerStats", [opts]); }
    /** Where the GUEST burns CPU: symbolized EIP/page histogram over a sampling window.
     *  The instrument for a stall the thunk profiler can't see (level loads, decode loops) —
     *  a Chrome trace only says `wasm-function[N]`, this says `module+0xrva`. Read
     *  `stoppedPct` first: high means the guest was parked, not computing. */
    eipProfile(opts?: { ms?: number; intervalMs?: number; top?: number }): this {
        return this.pushTimed("eipProfile", [opts], (opts?.ms ?? 3000) + 10_000);
    }
    /** GPU→CPU readback accounting: roundTrips (the real cost), memoHits, scratchHits,
     *  redundant (must be 0). {reset:true} zeroes after reading, so bracketing a
     *  tickFrames(N) gives round trips per frame. */
    readbackStats(opts?: { reset?: boolean }): this { return this.push("readbackStats", [opts]); }

    // ── time ──
    time(action: "freeze" | "advance" | "realtime", ms?: number): this { return this.push("time", [action, ms]); }
    /** Sample the guest clock against wall clock — `rate` <1 means game time is losing. */
    guestTime(opts?: { sampleMs?: number }): this { return this.pushTimed("guestTime", [opts], (opts?.sampleMs ?? 1000) + 5_000); }

    // ── breakpoints / exec control ──
    // Breakpoints block until hit — unbounded RPC envelope (the CLI's CDP budget /
    // an explicit clearBreaks bounds them). Pass {continuous:true} to return at once.
    breakOn(eip: number | string, opts?: { continuous?: boolean; pause?: boolean; fast?: boolean; when?: { arg: number; ebp?: boolean; eq?: number; ne?: number } }): this { return this.pushTimed("breakOn", [eip, opts], 0); }
    breakOnExport(name: string, opts?: { continuous?: boolean; pause?: boolean; fast?: boolean; when?: { arg: number; ebp?: boolean; eq?: number; ne?: number } }): this { return this.pushTimed("breakOnExport", [name, opts], 0); }
    breakOnSymbol(name: string, opts?: { continuous?: boolean; pause?: boolean; fast?: boolean; when?: { arg: number; ebp?: boolean; eq?: number; ne?: number } }): this { return this.pushTimed("breakOnSymbol", [name, opts], 0); }
    /** `argEq` breaks only when a stack argument matches — the way to hit ONE call of a hot API. */
    breakOnApi(pattern: string, opts?: { continuous?: boolean; argEq?: { index: number; value: number } }): this { return this.pushTimed("breakOnApi", [pattern, opts], 0); }
    clearBreaks(): this { return this.push("clearBreaks", []); }
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
