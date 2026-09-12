/**
 * cdp-worker-health.ts — watch the emulator's worker targets for the duration of some
 * other operation (a trace, a long run) and say, with timestamps, whether they SURVIVED it.
 *
 * Why this exists: when a DedicatedWorker dies, nothing in the tooling notices. The page
 * stays up, `worker.onerror` does not fire for a terminated worker, the log archive simply
 * stops mid-line, and the first thing an agent sees is an unrelated verb timing out 300 s
 * later ("pageEval timed out"). That reads as a tooling hang, not as "the thing you were
 * measuring is gone" — a whole session was lost to that once.
 *
 * Two tiers, because the cheap one is also the honest one:
 *   - EXISTENCE (always): poll `/json/list` over plain HTTP. No debugger session is attached
 *     to the worker, so this cannot itself change what it measures — which matters when the
 *     suspected killer is instrumentation.
 *   - HEAP (opt-in, `heap: true`): attach a flat session per worker and poll
 *     `Runtime.getHeapUsage`. This DOES perturb: an attached inspector session keeps a V8
 *     isolate in a debug-friendlier state. Use it to test a memory hypothesis, not as the
 *     default for a measurement run.
 *
 * Every CDP send is raced against a timeout: a worker blocked in `Atomics.wait` accepts the
 * attach and then never answers, and an unraced `send()` waits forever.
 */
import { CdpSession, DEFAULT_CDP_PORT, type CdpTarget } from "./cdp-core";

export interface WorkerHeapSample {
    /** ms since the watch started */
    t: number;
    targetId: string;
    usedMb: number;
    totalMb: number;
    /** How long the worker took to answer — a proxy for how starved its event loop is. */
    latencyMs: number;
}

export interface WorkerLifeEvent {
    t: number;
    kind: "present" | "gone" | "appeared" | "crashed" | "detached" | "unresponsive";
    targetId: string;
    detail?: string;
}

export interface ProcessMemorySample {
    t: number;
    pid: number;
    type: string;
    privateMb: number;
    workingSetMb: number;
}

export interface WorkerHealthReport {
    /** Wall-clock ms the watch covered. */
    durationMs: number;
    /** Worker target ids seen at any point, in order of first sighting. */
    seen: string[];
    /** Workers present when the watch started but absent when it ended. */
    died: string[];
    events: WorkerLifeEvent[];
    heap: WorkerHeapSample[];
    /** Peak used heap per worker, MB. */
    peakUsedMb: Record<string, number>;
    /** True if every worker present at the start was still present at the end. */
    survived: boolean;
    /** Per-process committed memory over the window (Windows only; empty elsewhere). */
    processMemory: ProcessMemorySample[];
}

const race = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([p.catch(() => null), Bun.sleep(ms).then(() => null)]);

async function listWorkers(port: number): Promise<CdpTarget[]> {
    try {
        const r = await fetch(`http://localhost:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) return [];
        return ((await r.json()) as CdpTarget[]).filter((t) => t.type === "worker");
    } catch {
        return [];
    }
}

export interface WorkerWatch {
    stop(): Promise<WorkerHealthReport>;
}

/**
 * Start watching. Call `stop()` to end the watch and get the report.
 *
 * `pageWsUrl` is only needed for `heap` — the existence tier talks to `/json/list` directly.
 */
export async function watchWorkerHealth(opts: {
    port?: number;
    intervalMs?: number;
    heap?: boolean;
    pageWsUrl?: string;
    /** Sample the renderer/GPU processes' COMMITTED memory. This is the number that matters
     *  for the memory cliff: every crash dump of this profile died between 3.4 and 3.7 GiB
     *  committed in the renderer, and nothing else in the tooling can see that figure — the
     *  worker's own `performance.memory` is unavailable and the JS heap is a tenth of it. */
    processMemory?: boolean;
} = {}): Promise<WorkerWatch> {
    const port = opts.port ?? DEFAULT_CDP_PORT;
    const intervalMs = opts.intervalMs ?? 500;
    const t0 = Date.now();
    const events: WorkerLifeEvent[] = [];
    const heap: WorkerHeapSample[] = [];
    const seen: string[] = [];
    let live = new Set<string>();
    let running = true;

    const initial = await listWorkers(port);
    for (const w of initial) {
        seen.push(w.id);
        live.add(w.id);
        events.push({ t: 0, kind: "present", targetId: w.id, detail: w.url || "(no url)" });
    }
    const startedWith = new Set(live);

    // Heap tier: one flat session per worker, attached up front. Workers that appear later
    // are not attached — the subject is the ones that were already running.
    let session: CdpSession | null = null;
    const heapSessions = new Map<string, string>();
    if (opts.heap && opts.pageWsUrl) {
        session = await CdpSession.connect(opts.pageWsUrl);
        session.on("Inspector.targetCrashed", (_p, sessionId) => {
            const id = [...heapSessions].find(([, s]) => s === sessionId)?.[0] ?? "?";
            events.push({ t: Date.now() - t0, kind: "crashed", targetId: id });
        });
        session.on("Target.detachedFromTarget", (p) => {
            const id = [...heapSessions].find(([, s]) => s === p?.sessionId)?.[0] ?? p?.targetId ?? "?";
            events.push({ t: Date.now() - t0, kind: "detached", targetId: id, detail: p?.reason });
        });
        // attachToTarget only resolves worker target ids once the page session knows about
        // them; without this the attach silently returns nothing and the heap tier reports an
        // empty record that reads exactly like "the heap never moved".
        await race(session.send("Target.setDiscoverTargets", { discover: true }), 5000);
        await race(session.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }), 5000);
        for (const w of initial) {
            const a: any = await race(session.send("Target.attachToTarget", { targetId: w.id, flatten: true }), 5000);
            const sid = a?.result?.sessionId;
            if (!sid) {
                events.push({ t: 0, kind: "unresponsive", targetId: w.id, detail: "heap tier: attach failed" });
                continue;
            }
            heapSessions.set(w.id, sid);
            await race(session.send("Runtime.enable", {}, sid), 5000);
        }
        if (!heapSessions.size) {
            events.push({ t: 0, kind: "unresponsive", targetId: "-", detail: "heap tier attached to NO worker — heap numbers below are absent, not zero" });
        }
    }

    const processMemory: ProcessMemorySample[] = [];
    const PROCESS_SAMPLE_MS = 2000;
    let lastProcessSample = 0;
    const sampleProcesses = (t: number) => {
        if (process.platform !== "win32") return;
        const ps = Bun.spawnSync(["powershell", "-NoProfile", "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
            "Where-Object { $_.CommandLine -match 'cdp-profile' } | " +
            "ForEach-Object { $t='browser'; if($_.CommandLine -match '--type=([a-z\-]+)'){$t=$Matches[1]}; " +
            "\"$($_.ProcessId),$t,$($_.PrivatePageCount),$($_.WorkingSetSize)\" }"]);
        for (const line of new TextDecoder().decode(ps.stdout).split(/\r?\n/)) {
            const [pid, type, priv, ws] = line.trim().split(",");
            if (!pid || !type) continue;
            if (type !== "renderer" && type !== "gpu-process") continue;
            processMemory.push({
                t, pid: Number(pid), type,
                privateMb: Math.round(Number(priv) / 2 ** 20),
                workingSetMb: Math.round(Number(ws) / 2 ** 20),
            });
        }
    };
    if (opts.processMemory) sampleProcesses(0);

    const loop = (async () => {
        while (running) {
            await Bun.sleep(intervalMs);
            if (!running) break;
            const t = Date.now() - t0;
            const now = new Set((await listWorkers(port)).map((w) => w.id));
            for (const id of live) {
                if (!now.has(id)) events.push({ t, kind: "gone", targetId: id });
            }
            for (const id of now) {
                if (!live.has(id)) {
                    if (!seen.includes(id)) seen.push(id);
                    events.push({ t, kind: "appeared", targetId: id });
                }
            }
            live = now;
            if (opts.processMemory && t - lastProcessSample >= PROCESS_SAMPLE_MS) {
                lastProcessSample = t;
                sampleProcesses(t);
            }
            if (!session) continue;
            for (const [id, sid] of heapSessions) {
                if (!live.has(id)) continue;
                const s0 = Date.now();
                const r: any = await race(session.send("Runtime.getHeapUsage", {}, sid), Math.max(2000, intervalMs * 2));
                const latencyMs = Date.now() - s0;
                if (!r?.result) {
                    events.push({ t, kind: "unresponsive", targetId: id, detail: `no heap answer in ${latencyMs}ms` });
                    continue;
                }
                heap.push({
                    t,
                    targetId: id,
                    usedMb: +(r.result.usedSize / 1e6).toFixed(1),
                    totalMb: +(r.result.totalSize / 1e6).toFixed(1),
                    latencyMs,
                });
            }
        }
    })();

    return {
        async stop(): Promise<WorkerHealthReport> {
            running = false;
            await loop;
            session?.close();
            const durationMs = Date.now() - t0;
            const died = [...startedWith].filter((id) => !live.has(id));
            const peakUsedMb: Record<string, number> = {};
            for (const s of heap) peakUsedMb[s.targetId] = Math.max(peakUsedMb[s.targetId] ?? 0, s.usedMb);
            if (opts.processMemory) sampleProcesses(durationMs);
            return { durationMs, seen, died, events, heap, peakUsedMb, survived: died.length === 0, processMemory };
        },
    };
}

/** One-line-per-fact summary for a CLI. Prints nothing reassuring unless it is true. */
export function formatWorkerHealth(r: WorkerHealthReport): string {
    const lines: string[] = [];
    const short = (id: string) => id.slice(0, 8);
    if (r.survived) {
        lines.push(`  workers: ${r.seen.length} seen, all alive after ${(r.durationMs / 1000).toFixed(1)}s`);
    } else {
        lines.push(`  WORKERS DIED: ${r.died.map(short).join(", ")} — the page survived, the worker did not.`);
        for (const e of r.events.filter((e) => e.kind !== "present")) {
            lines.push(`    t=${(e.t / 1000).toFixed(1)}s ${e.kind} ${short(e.targetId)}${e.detail ? ` (${e.detail})` : ""}`);
        }
    }
    const heapFailures = r.events.filter((e) => e.kind === "unresponsive" && e.detail?.startsWith("heap tier"));
    for (const e of heapFailures) lines.push(`  HEAP TIER UNAVAILABLE: ${e.detail}`);
    const renderer = r.processMemory.filter((s) => s.type === "renderer");
    if (renderer.length) {
        const biggest = renderer.reduce((a, b) => (b.privateMb > a.privateMb ? b : a));
        const own = renderer.filter((s) => s.pid === biggest.pid);
        const first = own[0], last = own[own.length - 1];
        lines.push(
            `  renderer pid ${biggest.pid}: committed ${(first.privateMb / 1024).toFixed(2)} -> ` +
            `${(last.privateMb / 1024).toFixed(2)} GiB (peak ${(biggest.privateMb / 1024).toFixed(2)}, ` +
            `${last.privateMb - first.privateMb >= 0 ? "+" : ""}${last.privateMb - first.privateMb} MB)`,
        );
        if (biggest.privateMb >= 3300) {
            lines.push("  NEAR THE CLIFF: every renderer crash recorded for this profile died between");
            lines.push("  3.4 and 3.7 GiB committed. Treat anything above ~3.3 GiB as one long trace from death.");
        }
    }
    for (const [id, peak] of Object.entries(r.peakUsedMb)) {
        const samples = r.heap.filter((s) => s.targetId === id);
        const first = samples[0], last = samples[samples.length - 1];
        const maxLat = Math.max(...samples.map((s) => s.latencyMs));
        lines.push(
            `  heap ${short(id)}: ${first?.usedMb ?? "?"} -> ${last?.usedMb ?? "?"} MB used ` +
            `(peak ${peak}, total ${last?.totalMb ?? "?"}), ${samples.length} samples, worst reply ${maxLat}ms`,
        );
    }
    return lines.join("\n");
}
