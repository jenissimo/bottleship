/**
 * Page-side harness facade — `window.__BS__.harness`, a thin page facade.
 * It forwards typed RPC to the worker HarnessService, surfaces the
 * normalized event bus, and owns ONLY the browser-only orchestration the worker
 * can't do (loadApp, the audio gesture). All real logic lives in the worker.
 *
 * Namespace decision: a single `window.__BS__` with `__BS__.harness`
 * (this, automation) and a reserved `__BS__.dx` slot (the React dx-tooling-vision
 * dashboard) sharing one worker-backed primitive layer — no second metrics path.
 *
 * Transports: the browser console can call `window.__BS__.harness.state(...)`
 * directly; the CLI/MCP ship a serialized step list to `__runSteps`. One logic
 * location (worker), one contract, three transports.
 */

import {
    HARNESS_RPC,
    HARNESS_CANCEL,
    HARNESS_REPLY,
    HARNESS_EVENT,
    HARNESS_DEFAULT_TIMEOUT_MS,
    type HarnessCallOpts,
    type HarnessReply,
    type HarnessEventMsg,
} from "../worker/harness/rpc";
import { sessionFromLocation } from "./session";
import type { HarnessStep, HarnessRunResult, HarnessStepResult } from "./types";
import { isSerializedFn } from "./types";
import { HarnessChain } from "./dsl";
import { SIDECAR_PORT } from "../utils/log-client";
import { INPUT_INDEX, KEY_BITFIELD_BASE, KEY_BITFIELD_COUNT } from "../input/sab-layout";
import { relativeIntent } from "../input/relative-intent";

/** Verbs handled page-side (browser-only) rather than forwarded to the worker. */
const BROWSER_ONLY = new Set([
    "openWgb", "loadPe", "audioGesture", "waitForEvent", "onModal", "inputSab",
    "hostRecord", "hostRecordStop", "hostReplay",
]);

export interface HarnessFacade {
    /** Low-level: invoke any worker command, await the {ok,result|error} reply. */
    rpc(cmd: string, args?: unknown[], opts?: HarnessCallOpts): Promise<unknown>;
    /** Cancel an in-flight rpc by its returned-promise (not exposed; internal). */
    /** Wait for a normalized event (harness bus OR legacy dbg_event). */
    waitForEvent(name: string, opts?: { timeoutMs?: number }): Promise<unknown>;
    /** Most recent payload for an event name (null if none seen). */
    lastEvent(name: string): unknown;
    /** Start a fluent chain. */
    chain(): HarnessChain;
    /** Execute a serialized step list (CLI/MCP entry); returns one POJO. */
    __runSteps(steps: HarnessStep[]): Promise<HarnessRunResult>;
    // Browser-only verbs:
    openWgb(idOrUrl: string, opts?: { hle?: boolean; logOnly?: boolean }): Promise<unknown>;
    loadPe(url: string): Promise<unknown>;
    audioGesture(): Promise<unknown>;
    /** Host-side snapshot of the published input record + touch transport state. */
    inputSab(): Promise<unknown>;
    /** Arm the page recorder so MANUAL play is captured (the worker's recorder
     *  only sees harness-injected input). */
    hostRecord(): Promise<unknown>;
    /** Disarm and return the captured samples. */
    hostRecordStop(): Promise<unknown>;
    /** Re-apply captured samples; deterministic replays from the sample stamps. */
    hostReplay(samples: unknown, opts?: { deterministic?: boolean }): Promise<unknown>;
    /** Auto-answer matching MessageBox prompts; returns a disposer. */
    onMessageBox(pattern: RegExp | string, reply?: number | string): () => void;
    /** Resolver App.tsx consults for a prompt; buttonId to auto-answer, null to defer. */
    autoModalReply(box: { text?: string; caption?: string }): number | null;
    // Generic worker verbs (state, click, breakOn, ...) reachable via the Proxy.
    [cmd: string]: unknown;
}

let facade: HarnessFacade | null = null;

/** Install the facade onto window.__BS__.harness. Called once from App.tsx with
 *  the worker handle. Idempotent. */
export function installHarnessFacade(worker: Worker, getInputView?: () => Int32Array | null): HarnessFacade {
    if (facade) return facade;

    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const lastEvents: Record<string, unknown> = {};
    const eventWaiters: Record<string, Array<(d: unknown) => void>> = {};
    // Auto-modal matchers: {pattern, button}. Win32 IDs IDOK=1, IDCANCEL=2, IDYES=6, IDNO=7.
    const BUTTON_IDS: Record<string, number> = { ok: 1, cancel: 2, abort: 3, retry: 4, ignore: 5, yes: 6, no: 7 };
    const modalMatchers: Array<{ test: (m: any) => boolean; button: number }> = [];

    worker.addEventListener("message", (ev: MessageEvent) => {
        const m = ev.data;
        if (!m || typeof m !== "object") return;
        if (m.type === HARNESS_REPLY) {
            const reply = m as HarnessReply;
            const p = pending.get(reply.id);
            if (!p) return;
            pending.delete(reply.id);
            if (reply.ok) p.resolve(reply.result);
            else {
                const e = new Error(reply.error?.message ?? "harness error");
                (e as Error & { code?: string }).code = reply.error?.code;
                p.reject(e);
            }
            return;
        }
        if (m.type === HARNESS_EVENT) {
            const evt = m as HarnessEventMsg;
            deliverEvent(evt.event, evt.data);
            return;
        }
        // Legacy dbg_event (dialogShow/dlgList/dlgClick) — keep waitForEvent working.
        if (m.type === "dbg_event" && typeof m.event === "string") {
            deliverEvent(m.event, m.data);
            return;
        }
    });

    /**
     * Register an auto-answer for MessageBox prompts. To avoid
     * two independent responders racing (and App.tsx's dev modal being left mounted
     * over the canvas), the harness does NOT reply itself — it exposes a single
     * resolver `window.__BS__.autoModalReply(box) -> buttonId|null` that App.tsx
     * consults in its one show_message_box handler before rendering its modal.
     */
    function onMessageBox(pattern: RegExp | string, reply: number | string = "ok"): () => void {
        const re = typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;
        const button = typeof reply === "number" ? reply : (BUTTON_IDS[reply.toLowerCase()] ?? 1);
        const entry = { test: (m: any) => re.test(String(m.text ?? "")) || re.test(String(m.caption ?? "")), button };
        modalMatchers.push(entry);
        return () => { const i = modalMatchers.indexOf(entry); if (i >= 0) modalMatchers.splice(i, 1); };
    }

    /** Resolver consulted by App.tsx: returns the button id for a matching prompt,
     *  or null to let App handle it (render dev modal / non-dev auto-reply). */
    function autoModalReply(box: { text?: string; caption?: string }): number | null {
        const m = modalMatchers.find((mm) => mm.test(box));
        return m ? m.button : null;
    }

    function deliverEvent(name: string, data: unknown): void {
        lastEvents[name] = data;
        const ws = eventWaiters[name];
        if (ws && ws.length) {
            eventWaiters[name] = [];
            for (const w of ws) w(data);
        }
        // A dead process will never deliver the event anyone is waiting for —
        // release every waiter instead of letting each sit out its timeout.
        if (name === "fault" && (data as { fatal?: boolean } | null)?.fatal) {
            for (const other of Object.keys(eventWaiters)) {
                const waiters = eventWaiters[other];
                if (!waiters?.length) continue;
                eventWaiters[other] = [];
                for (const w of waiters) w(null);
            }
        }
    }

    function rpc(cmd: string, args: unknown[] = [], opts?: HarnessCallOpts): Promise<unknown> {
        const id = nextId++;
        return new Promise<unknown>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            worker.postMessage({ type: HARNESS_RPC, id, cmd, args, opts });
            // Page-side safety timeout slightly beyond the worker's, so a dropped
            // reply (worker wedged) still settles the promise. Honor the documented
            // contract: an explicit timeoutMs<=0 disables the timer (no override =
            // default); otherwise the worker's no-timeout call would be falsely cancelled.
            const t = opts?.timeoutMs;
            const ms = t === undefined ? HARNESS_DEFAULT_TIMEOUT_MS : t;
            if (ms > 0) {
                setTimeout(() => {
                    if (pending.has(id)) {
                        pending.delete(id);
                        worker.postMessage({ type: HARNESS_CANCEL, id });
                        reject(new Error(`harness rpc '${cmd}' timed out after ${ms}ms (no reply)`));
                    }
                }, ms + 2000);
            }
        });
    }

    function waitForEvent(name: string, opts?: { timeoutMs?: number }): Promise<unknown> {
        const timeoutMs = opts?.timeoutMs ?? HARNESS_DEFAULT_TIMEOUT_MS;
        return new Promise((resolve) => {
            let done = false;
            const finish = (d: unknown) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(d);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            (eventWaiters[name] ??= []).push(finish);
        });
    }

    /** Wait for a raw worker message matching a predicate (load completion etc.). */
    function waitForWorkerMessage(pred: (m: any) => boolean, timeoutMs: number): Promise<any> {
        return new Promise((resolve) => {
            let done = false;
            const onMsg = (ev: MessageEvent) => {
                if (done) return;
                if (pred(ev.data)) {
                    done = true;
                    clearTimeout(timer);
                    worker.removeEventListener("message", onMsg);
                    resolve(ev.data);
                }
            };
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                worker.removeEventListener("message", onMsg);
                resolve(null);
            }, timeoutMs);
            worker.addEventListener("message", onMsg);
        });
    }

    /* ───────────────────────── browser-only verbs ───────────────────────── */

    /** Dev-sidecar bundle route — see serveWgb in tools/dev-sidecar. Probed once
     *  per session; null until probed, false when the sidecar is not running. */
    let wgbSidecar: boolean | null = null;

    async function sidecarAvailable(): Promise<boolean> {
        if (wgbSidecar !== null) return wgbSidecar;
        try {
            const r = await fetch(`http://localhost:${SIDECAR_PORT}/health`, { method: "GET" });
            wgbSidecar = r.ok;
        } catch { wgbSidecar = false; }
        return wgbSidecar;
    }

    async function resolveBundlePath(idOrUrl: string): Promise<string> {
        // A Windows path in a double-quoted JS literal is a trap: "g:\WGB\todo\bod.wgb"
        // is really `g:WGB<TAB>odo<BACKSPACE>od.wgb` — \t and \b are escapes and \W just
        // loses its backslash. The fetch then 404s and the ZIP reader reports "EOCD not
        // found", which sends the reader hunting for a corrupt bundle. Fail here, naming
        // the actual problem.
        const ctrl = idOrUrl.match(/[\x00-\x1f]/);
        if (ctrl) {
            const shown = [...idOrUrl].map((c) => (c.charCodeAt(0) < 32 ? `<${c.charCodeAt(0)}>` : c)).join("");
            throw new Error(
                `bundle path contains a control character (${shown}) — a "\\t"/"\\b"-style escape in a ` +
                `double-quoted literal. Use forward slashes ("g:/WGB/todo/x.wgb") or a raw string.`,
            );
        }
        if (/^https?:\/\//i.test(idOrUrl)) return idOrUrl;
        // Absolute disk path (Windows "X:\…"/"X:/…" or a POSIX "/…*.wgb") → stream it straight
        // off disk via Range, so the agent/make-wgb can hand a raw path — no symlink, no
        // hardcoded folder.
        //
        // Prefer the dev sidecar over Vite's /__wgb/ route: a bundle read is the hot path of
        // every boot (8 MB ranges while the guest thread is parked on a 30 s deadline), and
        // Vite's throughput on that route decays over a long-lived dev server until the
        // deadline blows ("SabIoSource: read timed out"). Falls back to the Vite route when
        // the sidecar is not running.
        const isWinAbs = /^[a-zA-Z]:[\\/]/.test(idOrUrl);
        const isPosixAbsWgb = idOrUrl.startsWith("/") && !idOrUrl.startsWith("/apps/")
            && !idOrUrl.startsWith("/__wgb/") && idOrUrl.toLowerCase().endsWith(".wgb");
        if (isWinAbs || isPosixAbsWgb) {
            const enc = encodeURIComponent(idOrUrl);
            return (await sidecarAvailable())
                ? `http://localhost:${SIDECAR_PORT}/wgb?path=${enc}`
                : `/__wgb/?path=${enc}`;
        }
        if (idOrUrl.includes("/")) return idOrUrl;                       // already a URL (/apps/…, /__wgb/…)
        // Bare id → a bundled demo served statically from public/apps.
        if (idOrUrl.toLowerCase().endsWith(".wgb")) return `/apps/${idOrUrl}`;
        return `/apps/${idOrUrl}.wgb`;
    }

    async function openWgb(idOrUrl: string, opts?: { hle?: boolean; logOnly?: boolean; reload?: boolean }): Promise<unknown> {
        const path = await resolveBundlePath(idOrUrl);
        const w = window as any;
        const loadDone = waitForWorkerMessage(
            (m) => m?.type === "loading_progress" && m.phase === "done",
            120_000,
        );
        if (opts?.hle && typeof w.enableHleAndLoad === "function") {
            await w.enableHleAndLoad(path, !!opts.logOnly);
        } else if (typeof w.loadApp === "function") {
            await w.loadApp(path);
        } else {
            throw new Error("window.loadApp not available (open ?game=dev)");
        }
        const done = await loadDone;
        return { path, loaded: !!done, progress: done ?? null };
    }

    /**
     * Set a worker A/B flag so it SURVIVES a reload.
     *
     * The worker-side verb only assigns `globalThis[key]` in the CURRENT worker, and
     * `openWgb()` reloads the page before loading (fresh worker + code) — so a chain of
     * `setWorkerFlag(...).openWgb(...)` silently lost the flag and every `__no*` A/B
     * measured the DEFAULT path while reporting success. (Observed: __noHeapSlab left
     * the slab counters byte-identical.) Persist through the same localStorage channel
     * the host replays on every worker init, BEFORE any game loads, then forward the RPC
     * so the flag also applies to the live worker.
     */
    async function setWorkerFlag(key: string, value: unknown): Promise<unknown> {
        if (typeof key !== "string" || !key.startsWith("__")) {
            throw new Error(`setWorkerFlag: refusing non-dunder flag '${String(key)}'`);
        }
        // Session-scoped store when this tab has a ?bs=<name>: localStorage is origin-wide,
        // so a global flag would silently apply to every parallel agent's tab too.
        const session = sessionFromLocation(window.location.search);
        const store = session ? `bs_debug_flags:${session}` : "bs_debug_flags";
        let persisted = false;
        try {
            const flags = JSON.parse(localStorage.getItem(store) || "{}");
            if (value === undefined || value === null) delete flags[key]; else flags[key] = value;
            localStorage.setItem(store, JSON.stringify(flags));
            persisted = true;
        } catch (e) {
            // Fail LOUDLY: a silently-unpersisted flag is worse than no flag, because the
            // A/B that follows looks like it ran.
            throw new Error(`setWorkerFlag('${key}'): could not persist to localStorage ` +
                `(${(e as Error).message}) — the flag would be lost by openWgb's reload, ` +
                `so the A/B would measure the default path. Refusing.`);
        }
        const live = await rpc("setWorkerFlag", [key, value]);
        return { ...(live as object), persisted, survivesReload: persisted, store };
    }

    async function loadPe(url: string): Promise<unknown> {
        const w = window as any;
        if (typeof w.loadApp !== "function") throw new Error("window.loadApp not available");
        const loadDone = waitForWorkerMessage((m) => m?.type === "ready" || (m?.type === "loading_progress" && m.phase === "done"), 120_000);
        await w.loadApp(url);
        return { url, loaded: !!(await loadDone) };
    }

    /**
     * What the host last PUBLISHED into the input SAB, plus the state that decides how
     * a contact is translated. The guest-side view is `state(["input"])`; this is the
     * other half — it answers "did the host even see that gesture" without a game loaded.
     */
    async function inputSab(): Promise<unknown> {
        const view = getInputView?.();
        if (!view) return { attached: false };
        const keys: number[] = [];
        for (let w = 0; w < KEY_BITFIELD_COUNT; w++) {
            const bits = view[KEY_BITFIELD_BASE + w];
            for (let b = 0; b < 32; b++) if (bits & (1 << b)) keys.push(w * 32 + b);
        }
        return {
            attached: true,
            seq: Atomics.load(view, INPUT_INDEX.seq),
            mouse: {
                x: view[INPUT_INDEX.mouseX],
                y: view[INPUT_INDEX.mouseY],
                buttons: view[INPUT_INDEX.buttons],
                inside: view[INPUT_INDEX.mouseInside] !== 0,
                wheel: view[INPUT_INDEX.mouseWheel],
                dinputDX: view[INPUT_INDEX.dinputDX],
                dinputDY: view[INPUT_INDEX.dinputDY],
            },
            keysDown: keys,
            pad: {
                connected: view[INPUT_INDEX.gamepadConnected] === 1,
                buttons: view[INPUT_INDEX.gamepadButtons],
                axes: [
                    view[INPUT_INDEX.gamepadAxis0], view[INPUT_INDEX.gamepadAxis1],
                    view[INPUT_INDEX.gamepadAxis2], view[INPUT_INDEX.gamepadAxis3],
                ],
            },
            relativeIntent: { active: relativeIntent.get(), reasons: relativeIntent.reasons() },
            pointerLocked: document.pointerLockElement !== null,
            // Under Pointer Lock the OS pointer is hidden and the guest cursor is ours to
            // draw; `drawn:false` while locked with a visible guest cursor = no pointer.
            cursorOverlay: (window as any).__BS__?.cursorOverlay ?? { drawn: false },
            maxTouchPoints: navigator.maxTouchPoints,
        };
    }

    /* ── host input capture ───────────────────────────────────────────────────
     * The HUMAN's mouse/keyboard reaches the guest through the page's SAB
     * publication, not through applyInput — so the worker's present-serial
     * recorder never sees manual play. These forward to the page recorder, which
     * captures the published SAB record; that makes "play it once by hand" a
     * re-runnable artifact instead of something only a person can reproduce.
     * Samples are edge-recorded and level-applied, so a key held across many
     * samples replays as held. */

    async function hostRecord(): Promise<unknown> {
        const start = (window as any).startRecording;
        if (typeof start !== "function") throw new Error("host recorder unavailable (App not mounted)");
        start();
        return { recording: true };
    }

    async function hostRecordStop(): Promise<unknown> {
        const stop = (window as any).stopRecording;
        if (typeof stop !== "function") throw new Error("host recorder unavailable (App not mounted)");
        const samples = stop() ?? [];
        return { recording: false, samples, count: samples.length };
    }

    /** hostReplay(samples, {deterministic?}) — deterministic drives manual virtual
     *  time from the sample stamps, so replay does not depend on host wall-clock. */
    async function hostReplay(samples: unknown, opts?: { deterministic?: boolean }): Promise<unknown> {
        const play = (window as any).playRecording;
        if (typeof play !== "function") throw new Error("host replay unavailable (App not mounted)");
        const list = Array.isArray(samples) ? samples : [];
        if (!list.length) throw new Error("hostReplay: empty recording");
        play(list, opts);
        return { replaying: true, count: list.length, deterministic: opts?.deterministic ?? true };
    }

    async function audioGesture(): Promise<unknown> {
        // Manual-mode only: a synthetic event can't satisfy the
        // autoplay policy — automation should launch Chrome with
        // --autoplay-policy=no-user-gesture-required instead. This dispatches a
        // best-effort click for console use.
        const canvas = document.querySelector("canvas");
        if (canvas) {
            const r = canvas.getBoundingClientRect();
            const opts = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true };
            canvas.dispatchEvent(new MouseEvent("mousedown", opts));
            canvas.dispatchEvent(new MouseEvent("mouseup", opts));
            canvas.dispatchEvent(new MouseEvent("click", opts));
        }
        return { dispatched: !!canvas, note: "synthetic; use --autoplay-policy in automation" };
    }

    /* ─────────────────────── serialized step executor ───────────────────── */

    async function runOneStep(step: HarnessStep): Promise<unknown> {
        if (step.cmd === "setWorkerFlag") return setWorkerFlag(step.args[0] as string, step.args[1]);
        if (step.cmd === "openWgb") return openWgb(step.args[0] as string, step.args[1] as any);
        if (step.cmd === "loadPe") return loadPe(step.args[0] as string);
        if (step.cmd === "audioGesture") return audioGesture();
        if (step.cmd === "inputSab") return inputSab();
        if (step.cmd === "hostRecord") return hostRecord();
        if (step.cmd === "hostRecordStop") return hostRecordStop();
        if (step.cmd === "hostReplay") return hostReplay(step.args[0], step.args[1] as any);
        if (step.cmd === "waitForEvent") return waitForEvent(step.args[0] as string, step.args[1] as any);
        if (step.cmd === "onModal") { onMessageBox((step.args[0] as string) ?? ".*", (step.args[1] as string | number) ?? "ok"); return { armed: true, pattern: step.args[0] ?? ".*" }; }
        // Predicate args (waitUntil) are pre-serialized as {__fn} — pass through;
        // the worker reconstructs and evaluates them in its own context.
        return rpc(step.cmd, step.args, step.opts);
    }

    async function __runSteps(steps: HarnessStep[]): Promise<HarnessRunResult> {
        const result: HarnessRunResult = { ok: true, steps: [], named: {} };
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const t0 = performance.now();
            try {
                const r = await runOneStep(step);
                const sr: HarnessStepResult = { cmd: step.cmd, label: step.label, ok: true, result: r, ms: performance.now() - t0 };
                result.steps.push(sr);
                result.named[step.cmd] = r;
            } catch (err) {
                const e = err as Error & { code?: string };
                result.steps.push({ cmd: step.cmd, label: step.label, ok: false, error: { message: e.message, code: e.code }, ms: performance.now() - t0 });
                result.ok = false;
                result.error = { message: e.message, code: e.code, atStep: i, cmd: step.cmd };
                // Auto-capture a fault-grade snapshot on abort.
                try {
                    result.faultSnapshot = await rpc("state", [["cpu", "threads", "memory", "rings"]], { timeoutMs: 10_000 });
                } catch { /* best-effort */ }
                break;
            }
        }
        return result;
    }

    /* ───────────────────────────── assembly ────────────────────────────── */

    const base = {
        rpc,
        waitForEvent,
        lastEvent: (name: string) => lastEvents[name] ?? null,
        chain: () => new HarnessChain((steps) => __runSteps(steps)),
        __runSteps,
        openWgb,
        loadPe,
        audioGesture,
        inputSab,
        hostRecord,
        hostRecordStop,
        hostReplay,
        onMessageBox,
        autoModalReply,
    };

    // Proxy so any worker command is callable as harness.<cmd>(...args) (like the
    // legacy window.dbg Proxy) while the explicit methods above take precedence.
    facade = new Proxy(base as unknown as HarnessFacade, {
        get(target, prop: string) {
            if (prop in target) return (target as any)[prop];
            if (BROWSER_ONLY.has(prop)) return (target as any)[prop];
            // Unknown -> treat as a worker command.
            return (...args: unknown[]) => rpc(prop, args);
        },
    });

    const w = window as any;
    w.__BS__ = w.__BS__ ?? {};
    w.__BS__.harness = facade;
    // Convenience alias used in some docs/scripts.
    w.harness = facade;
    return facade;
}
