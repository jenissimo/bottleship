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
    logs(count?: number, filter?: string): this { return this.push("logs", [count, filter]); }
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

    // ── observe ──
    state(sections?: string[]): this { return this.push("state", [sections]); }
    /** On-demand guest call-stack (module-labelled). Pair with breakOnApi('kernel32:ExitProcess') to see who called exit. */
    backtrace(esp?: number): this { return this.push("backtrace", [esp]); }
    /** Deduplicated registry of UNIMPLEMENTED thunks the guest called (id + count + caller). Firehose-immune stub finder. */
    stubs(): this { return this.push("stubs", []); }
    /** One-shot incident report: cpu + backtrace + last thunks + stubs + faults + threads. The go-to for ANY anomaly (freeze/crash/exit/black frame). */
    report(esp?: number): this { return this.push("report", [esp]); }
    /** Recent guest page faults (EIP / fault addr / thread / last thunk / regs). */
    faults(n?: number): this { return this.push("faults", [n]); }
    shot(opts?: { save?: string }): this { return this.push("shot", [opts]); }
    captureFrame(opts?: { dumpTargets?: boolean }): this { return this.push("captureFrame", [opts]); }
    textures(): this { return this.push("textures", []); }
    dumpTexture(sel: string | { stage: number }): this { return this.push("dumpTexture", [sel]); }
    dumpSurface(sel: string): this { return this.push("dumpSurface", [sel]); }

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
    breakOnApi(pattern: string, opts?: { continuous?: boolean }): this { return this.pushTimed("breakOnApi", [pattern, opts], 0); }
    watchMem(addr: number | string, opts?: { onWrite?: boolean }): this { return this.push("watchMem", [addr, opts]); }
    pause(): this { return this.push("pause", []); }
    resume(): this { return this.push("resume", []); }

    // ── record / replay (present-serial gated) ──
    record(): this { return this.push("record", []); }
    recordStop(): this { return this.push("recordStop", []); }
    replay(recording: unknown): this { return this.pushTimed("replay", [recording], 0); }

    // ── filesystem / registry ──
    fsRead(path: string): this { return this.push("fsRead", [path]); }
    fsDelete(path: string): this { return this.push("fsDelete", [path]); }
    fsList(path: string): this { return this.push("fsList", [path]); }
    fsStat(path: string): this { return this.push("fsStat", [path]); }
    regGet(root: string, key: string, value?: string): this { return this.push("regGet", [root, key, value]); }

    // ── assertions (worker rejects -> chain aborts) ──
    expect(cmd: string, ...args: unknown[]): this { return this.push(cmd, args); }
    expectDialog(title: string): this { return this.push("expectDialog", [title]); }
    expectSurfaceNonBlack(sel?: string): this { return this.push("expectSurfaceNonBlack", [sel]); }
    expectThread(opts: { state?: string; eip?: number }): this { return this.push("expectThread", [opts]); }
    expectFileExists(path: string): this { return this.push("expectFileExists", [path]); }

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
