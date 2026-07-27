/**
 * harness.state(sections?) — one structured JSON snapshot composed from the
 * typed serializers. Replaces the scattered console-printing
 * dbg.surfs/u32wins/snapshot/audio/mods with a single POJO an agent can query
 * (`state.surfaces.find(s => s.isPrimary)`) instead of grepping logs.
 *
 * Also registers the core introspection verbs every transport needs: ping
 * (health), commands (discovery), and cpu (quick register read).
 */

import type { HarnessService } from "../service";
import { harnessBus } from "../event-bus";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { STATE_SECTIONS, serializeCpu, serializeThreads, sys, proc, symbolize } from "../serialize";
import { buildHarnessReport } from "../build-report";
import { getCxxExceptionRing, getActiveCatchRecords } from "../../core/seh-dispatch";
import { faultRecorder } from "../../core/memory/fault-recorder";
import { stubRegistry } from "../../core/diagnostics/stub-registry";
import { getProcAddressRegistry } from "../../core/diagnostics/get-proc-address-registry";
import { apiCensus } from "../../core/diagnostics/api-census";

export function registerStateCommands(svc: HarnessService): void {
    /** Health probe: confirms the worker harness is wired and a process is (or isn't) loaded. */
    svc.register("ping", () => ({
        ok: true,
        ts: performance.now(),
        hasProcess: !!sys().process,
        paused: !!sys().isPaused,
    }));

    /** List all registered harness commands (discovery for repl / docs). */
    svc.register("commands", () => svc.list());

    /**
     * state(sections?: string[]) — compose the requested sections (default: all).
     * Unknown section names throw BAD_ARGS so typos surface instead of silently
     * returning nothing.
     */
    svc.register("state", (args) => {
        const requested = Array.isArray(args[0]) ? (args[0] as string[]) : Object.keys(STATE_SECTIONS);
        const out: Record<string, unknown> = {};
        for (const name of requested) {
            const fn = STATE_SECTIONS[name];
            if (!fn) {
                throw new HarnessError(
                    `unknown state section '${name}' (valid: ${Object.keys(STATE_SECTIONS).join(", ")})`,
                    HarnessErrorCode.BAD_ARGS,
                );
            }
            out[name] = fn();
        }
        return out;
    });

    /** Quick CPU register snapshot (subset of state(['cpu'])). */
    svc.register("cpu", () => serializeCpu());

    /**
     * readBytes(addr, len=64) — read raw guest memory and return it as hex. The missing
     * primitive for inspecting unpacked code / strings / structs live (e.g. SafeDisc games
     * decrypt their real code into memory with no on-disk file, so static RE is impossible —
     * this reads the unpacked bytes for capstone disassembly). Goes through harness_rpc, which
     * the worker services between scheduler quanta, so it works even while v86 is running
     * (unlike a worker-target CDP eval, which starves on a busy worker).
     */
    svc.register("readBytes", (args) => {
        const addr = ((args[0] as number) ?? 0) >>> 0;
        const len = Math.min(Math.max(((args[1] as number) ?? 64) >>> 0, 1), 0x10000);
        const mem = sys().process?.getCurrentMemory?.();
        if (!mem) throw new HarnessError("no guest memory (no process loaded?)", HarnessErrorCode.BAD_ARGS);
        if (addr + len > mem.length) throw new HarnessError(`range 0x${addr.toString(16)}+${len} exceeds mem 0x${mem.length.toString(16)}`, HarnessErrorCode.BAD_ARGS);
        const slice = mem.subarray(addr, addr + len);
        let hex = "";
        for (let i = 0; i < slice.length; i++) hex += slice[i].toString(16).padStart(2, "0");
        return { base: "0x" + addr.toString(16), len, hex };
    });

    /**
     * resolveExport('core', '?GErrorHist@@3PADA', {str?, wide?, len?}) — resolve a module
     * EXPORT (by name or "ord_N") to its LIVE address via the module registry (no JIT-off,
     * unlike breakOnExport which arms an EIP bp). With {str:true} it also reads a NUL-
     * terminated string at that address — handy for reading engine globals like Unreal's
     * GErrorHist (the fatal-error message buffer) without hunting for the live base by hand.
     * {wide:true} reads UTF-16; {len} caps the scan (default 1024).
     */
    svc.register("resolveExport", (args) => {
        const mod = String(args[0] ?? "");
        const exp = String(args[1] ?? "");
        const opts = (args[2] ?? {}) as { str?: boolean; wide?: boolean; len?: number };
        const mr = proc()?.moduleRegistry as { getExportAddress?: (m: string, e: string) => number | undefined } | undefined;
        const addr = mr?.getExportAddress?.(mod, exp);
        if (addr === undefined) throw new HarnessError(`export ${mod}!${exp} not found (module loaded yet?)`, HarnessErrorCode.NOT_FOUND);
        const out: Record<string, unknown> = { module: mod, export: exp, addr: "0x" + (addr >>> 0).toString(16) };
        if (opts.str) {
            const mem = sys().process?.getCurrentMemory?.();
            if (mem) {
                const max = Math.min(Math.max((opts.len ?? 1024) >>> 0, 1), 0x10000);
                const step = opts.wide ? 2 : 1;
                let s = "";
                for (let i = 0; i + step <= max && (addr >>> 0) + i + step <= mem.length; i += step) {
                    const code = opts.wide ? (mem[addr + i] | (mem[addr + i + 1] << 8)) : mem[addr + i];
                    if (code === 0) break;
                    s += String.fromCharCode(code);
                }
                out.str = s;
            }
        }
        return out;
    });

    /**
     * sehLog(n=20) — recent C++ (0xe06d7363) exceptions seen by the dispatcher: decoded
     * type descriptor + string payload, throw-site module, rethrow flag, and outcome
     * (caught by which module / unhandled→terminate). One call answers "what is the game
     * throwing and is it being caught" without grepping the log firehose. The usual root
     * cause of an MSVC/UE "Runtime Error! terminate" dialog is an `unhandled` entry here.
     */
    svc.register("sehLog", (args) => {
        const n = Math.min(Math.max(((args[0] as number) ?? 20) >>> 0, 1), 64);
        const ring = getCxxExceptionRing();
        return {
            count: ring.length,
            recent: ring.slice(-n).map((e) => ({
                seq: e.seq,
                threadId: e.threadId,
                type: e.typeName,
                thrown: e.thrownStr,
                throwEip: "0x" + (e.throwEip >>> 0).toString(16),
                throwModule: e.throwModule.trim(),
                rethrow: e.isRethrow,
                outcome: e.outcome,
                caughtBy: e.caughtBy,
            })),
            // Catch funclets currently executing (per-thread LIFO). A non-empty stack
            // means a throw right now would be a throw OUT OF a catch body.
            activeCatches: getActiveCatchRecords().map((t) => ({
                teb: `0x${t.teb.toString(16)}`,
                records: t.records.map((r) => ({
                    seq: r.seq,
                    pRN: `0x${r.pRN.toString(16)}`,
                    catchAddr: `0x${r.catchAddr.toString(16)}`,
                    savedTryEsp: `0x${r.savedTryEsp.toString(16)}`,
                    continuationEsp: `0x${r.continuationEsp.toString(16)}`,
                    tryRange: `${r.tryLow}-${r.tryHigh}/${r.catchHigh}`,
                    obj: `0x${r.pExceptionObject.toString(16)}`,
                })),
            })),
        };
    });

    /**
     * report() — the one-shot incident report. ANY non-standard situation (the
     * game "vanished"/froze, a black frame, a wild EIP, an unexpected exit) → call
     * this. Bundles, in a single firehose-immune POJO: CPU regs, the guest call
     * stack (module-labelled), the recent WinAPI ring (last thunks), the
     * unimplemented-thunk registry (stubs — the usual root cause of a graceful
     * "unsupported -> exit" bail), recent page faults, and a thread summary.
     * `esp` optionally overrides the stack root (else the live CPU esp).
     */
    svc.register("report", (args) => {
        const esp = typeof args[0] === "number" ? (args[0] as number) >>> 0 : undefined;
        return buildHarnessReport(esp);
    });

    /**
     * asyncParked() — diagnose a thread stuck in WAITING/ASYNC_THUNK. report()
     * shows the scheduler state but NOT which async thunk parked the thread or whether its
     * completion fired. This classifies every async park into one of three buckets so a
     * "thread hung in async" is root-caused without grepping the firehose:
     *   - inFlight: Promise NOT yet resolved (sorted oldest-first; a multi-second ageMs =
     *     the async JS op itself hung — e.g. a GPU readback mapAsync that never resolved).
     *   - pending: Promise resolved but the safe-point apply hasn't run (wake propagation gap).
     *   - orphanParkedTids: scheduler says ASYNC_THUNK but neither side has a record (lost both).
     */
    svc.register("asyncParked", () => {
        const now = performance.now();
        const d = proc()?.dispatcher as {
            getActiveAsyncThunks?: () => Array<{ functionId: number; functionName?: string; startTime: number; threadId?: number; esp?: number; returnAddr?: number }>;
            getPendingAsyncRestores?: () => Array<{ threadId?: number; completionName: string; returnAddr?: number; esp?: number }>;
        } | undefined;
        if (!d?.getActiveAsyncThunks) {
            throw new HarnessError("dispatcher unavailable (no process loaded?)", HarnessErrorCode.BAD_ARGS);
        }
        const hx = (v?: number | null) => (v === undefined || v === null ? null : "0x" + (v >>> 0).toString(16));
        const sym = (v?: number) => (v === undefined ? null : symbolize(v));

        // For a GetMessage/PeekMessage-parked thread, decode the call args off its stack
        // (live, by the parked esp) and ask the message queue whether a message is actually
        // waiting for it. This splits the two failure modes:
        //   (b) a message IS queued but the thread is still parked → our wake/delivery dropped it;
        //   (a) the queue is EMPTY → nobody posted to this thread → RE who should PostMessage it.
        const mq = (sys().windowManager as unknown as { messageQueue?: any } | undefined)?.messageQueue;
        const memU8 = sys().process?.getCurrentMemory?.();
        const dv = memU8 ? new DataView(memU8.buffer, memU8.byteOffset, memU8.byteLength) : null;
        const u32 = (a: number): number | null => (dv && a >= 0 && a + 4 <= memU8!.byteLength ? dv.getUint32(a, true) : null);
        const diagnoseGetMessage = (tid: number | null, esp?: number) => {
            if (esp === undefined) return null;
            // GetMessage(lpMsg, hWnd, wMsgFilterMin, wMsgFilterMax); [esp]=retAddr, args above.
            const lpMsg = u32(esp + 4), hWnd = u32(esp + 8), fMin = u32(esp + 12), fMax = u32(esp + 16);
            const out: Record<string, unknown> = { hWnd: hx(hWnd), lpMsg: hx(lpMsg), filterMin: hx(fMin), filterMax: hx(fMax) };
            if (mq && tid != null) {
                const hasAny = !!mq.hasMessages?.(0, 0, tid);
                const hasFiltered = fMin != null && fMax != null ? !!mq.hasMessages?.(fMin, fMax, tid) : null;
                const peeked = mq.peek?.(0, 0, tid);
                const waiters = Array.isArray(mq.waiters)
                    ? mq.waiters.filter((w: any) => w.threadId === tid).map((w: any) => ({ settled: !!w.settled }))
                    : null;
                out.queue = {
                    hasAnyMessage: hasAny,
                    hasFilteredMessage: hasFiltered,
                    peekedMsg: peeked ? hx(peeked.message) : null,
                    waiters,
                    // A GetMessage(NULL)-pump with an EMPTY queue is NORMAL Win32 idle — the
                    // thread legitimately blocks until someone posts, possibly forever. It is
                    // only a bug if (b) a message IS queued yet the thread stays parked, or if
                    // another thread is provably blocked waiting on this pump (caller must check).
                    idle: !hasAny,
                    verdict: hasAny
                        ? "MESSAGE QUEUED but thread still parked → WAKE BUG (b: drainWaiters/delivery dropped the wake)"
                        : "queue EMPTY + waiter armed → IDLE message-pump (normal Win32 GetMessage wait; NOT a hang unless another thread blocks on it)",
                };
            }
            return out;
        };
        const inFlight = (d.getActiveAsyncThunks() ?? [])
            .map((t) => {
                const name = t.functionName ?? `fn#${t.functionId}`;
                const base = { tid: t.threadId ?? null, name, ageMs: Math.round(now - t.startTime), returnAddr: hx(t.returnAddr), returnSym: sym(t.returnAddr), esp: hx(t.esp) };
                return /GetMessage|PeekMessage/i.test(name) ? { ...base, getMessage: diagnoseGetMessage(t.threadId ?? null, t.esp) } : base;
            })
            .sort((a, b) => b.ageMs - a.ageMs);
        const pending = (d.getPendingAsyncRestores?.() ?? [])
            .map((r) => ({ tid: r.threadId ?? null, name: r.completionName, returnAddr: hx(r.returnAddr), returnSym: sym(r.returnAddr), esp: hx(r.esp) }));
        const ts = serializeThreads() as { threads?: Array<{ id: number; waitReasonName: string | null }> };
        const parkedTids = (ts.threads ?? []).filter((t) => t.waitReasonName === "ASYNC_THUNK").map((t) => t.id);
        const known = new Set<number>([...inFlight.map((t) => t.tid), ...pending.map((p) => p.tid)].filter((x): x is number => x != null));
        const orphanParkedTids = parkedTids.filter((tid) => !known.has(tid));
        // An idle GetMessage(NULL)-pump with an empty queue is NOT stuck — skip it when
        // picking the headline suspect, else every idle UI thread reads as a false "hang".
        type InFlight = (typeof inFlight)[number] & { getMessage?: { queue?: { idle?: boolean; verdict?: string } } };
        const isIdlePump = (t: InFlight) => t.getMessage?.queue?.idle === true;
        const top = inFlight.find((t) => (t as InFlight).ageMs > 1000 && !isIdlePump(t as InFlight)) as InFlight | undefined;
        const idlePumps = inFlight.filter((t) => isIdlePump(t as InFlight)).map((t) => t.tid);
        const hint = top
            ? `tid ${top.tid} in-flight ${top.ageMs}ms on '${top.name}'` +
              (top.getMessage?.queue?.verdict
                  ? ` — ${top.getMessage.queue.verdict}`
                  : ` (ret ${top.returnSym ?? top.returnAddr}) — Promise never resolved (hung async op)`)
            : idlePumps.length
                ? `no stuck async parks — ${idlePumps.length} idle GetMessage pump(s) (tids ${idlePumps.join(",")}) waiting for work (normal)`
            : orphanParkedTids.length
                ? `tids ${orphanParkedTids.join(",")} parked but no async record — lost wake`
                : pending.length
                    ? `${pending.length} resolved restore(s) not applied — safe-point apply not reached`
                    : "no stuck async parks";
        return { now: Math.round(now), parkedTids, inFlight, pending, orphanParkedTids, hint };
    });

    /**
     * stubs() — the deduplicated registry of UNIMPLEMENTED thunks the guest has
     * called (vtable slot / export with no JS handler), with hit count + the guest
     * caller (symbolized). The firehose-immune way to find the under-implemented API
     * a game bailed on: e.g. NFSU's quality slider → unimplemented d3d9 CreateCubeTexture
     * → graceful exit(0). One query instead of grepping MB/s of logs.
     */
    svc.register("stubs", () => {
        return stubRegistry.list().map((s) => ({
            api: s.key,
            id: "0x" + s.functionId.toString(16),
            count: s.count,
            firstCaller: "0x" + s.firstCaller.toString(16),
            firstCallerSym: symbolize(s.firstCaller),
            lastCaller: "0x" + s.lastCaller.toString(16),
        }));
    });

    /**
     * getProcMisses() — GetProcAddress lookups that returned NULL (ERROR_PROC_NOT_FOUND),
     * deduped with hit count + guest caller. Shorthand for report().getProcMisses.
     */
    svc.register("getProcMisses", () => {
        return getProcAddressRegistry.misses().map((h) => ({
            module: "0x" + h.hModule.toString(16),
            proc: h.procName,
            count: h.count,
            firstCaller: "0x" + h.firstCaller.toString(16),
            firstCallerSym: symbolize(h.firstCaller),
            lastCaller: "0x" + h.lastCaller.toString(16),
            lastCallerSym: symbolize(h.lastCaller),
        }));
    });

    /**
     * apiCoverage() — the RUNTIME half of the pre-flight census, in one POJO: what this
     * session actually reached for, and how much of it we really answered.
     *
     * The static census (`bun tools/api-census.ts <bundle.wgb>`) reads the import tables
     * and says what a title links against. Two whole classes of use are invisible there
     * and only observable here:
     *   - GetProcAddress — a dynamic resolution appears in no import table, and legacy
     *     titles hide their optional/versioned behaviour behind exactly that. `dynamic`
     *     reports each distinct lookup with what the returned address LEADS to, and
     *     `unsatisfied` is the subset the guest could not use (NULL / stub / silent).
     *   - COM vtable slots — never imports at all. They arrive through the same thunk
     *     dispatch as flat exports ("d3d9:IDirect3DDevice9_DrawPrimitive"), so `com`
     *     counts them out of the call census and `missing` picks up the unimplemented
     *     slots from the stub registry.
     *
     * Ranked by call count, so the output is a work order rather than a wall of names.
     * `silent` is listed separately and first on purpose: a handler that returns success
     * without doing the work is worse than a missing one — the guest is told it worked.
     */
    svc.register("apiCoverage", (args) => {
        const limit = typeof args[0] === "number" ? Math.max(1, args[0] as number) : 25;
        const hex = (v: number): string => "0x" + (v >>> 0).toString(16);

        const called = apiCensus.list();
        const com = called.filter((c) => c.name.includes("_"));
        const dynamic = getProcAddressRegistry.list();

        return {
            byKind: getProcAddressRegistry.byKind(),
            totals: {
                apisCalled: called.length,
                comMethodsCalled: com.length,
                dynamicLookups: dynamic.length,
                silentStubsCalled: apiCensus.suspectStubs().length,
                unimplementedHit: stubRegistry.list().length,
            },
            /** Handlers that ran, reported success, and did nothing. Fix these first. */
            silent: apiCensus.suspectStubs().slice(0, limit).map((s) => ({
                api: s.name, count: s.count, arity: s.arity,
                lastCaller: hex(s.lastCaller), lastCallerSym: symbolize(s.lastCaller),
            })),
            /** Called with no handler at all — includes COM vtable slots. */
            missing: stubRegistry.list()
                .sort((a, b) => b.count - a.count).slice(0, limit)
                .map((s) => ({
                    api: s.key, count: s.count,
                    lastCaller: hex(s.lastCaller), lastCallerSym: symbolize(s.lastCaller),
                })),
            /** GetProcAddress results the guest cannot use, most-requested first. */
            unsatisfied: getProcAddressRegistry.unsatisfied().slice(0, limit).map((h) => ({
                proc: h.procName, dll: h.dll ?? hex(h.hModule), kind: h.kind, count: h.count,
                lastCaller: hex(h.lastCaller), lastCallerSym: symbolize(h.lastCaller),
            })),
            /** Every distinct dynamic resolution, with what the address leads to. */
            dynamic: dynamic.slice(0, limit).map((h) => ({
                proc: h.procName, dll: h.dll ?? hex(h.hModule), kind: h.kind,
                addr: hex(h.address), count: h.count,
            })),
        };
    });

    /**
     * apiCensus() — EVERY unique DX/COM/WinAPI method the guest has called this session
     * (deduped, hit-count + last guest caller), newest-hit first. Unlike stubs() (no
     * handler) this lists what's ACTUALLY exercised — the triage list for "where is the
     * buggy/garbage-returning implementation?" when corruption surfaces far from its
     * source. `suspect` marks likely SILENT stubs (handler ignores its args / curated).
     * Pass true to get only the suspect-stub subset (== report().silentStubs).
     */
    svc.register("apiCensus", (args) => {
        const onlySuspect = args[0] === true || args[0] === "suspect";
        const rows = onlySuspect ? apiCensus.suspectStubs() : apiCensus.list();
        return rows.map((s) => ({
            api: s.name,
            count: s.count,
            arity: s.arity,
            suspect: s.suspectStub,
            lastCaller: "0x" + s.lastCaller.toString(16),
            lastCallerSym: symbolize(s.lastCaller),
        }));
    });

    /** silentStubs() — shorthand for apiCensus(true): only the called methods flagged
     *  as likely silent stubs (the "pretend to work" handlers). */
    svc.register("silentStubs", () => apiCensus.suspectStubs().map((s) => ({
        api: s.name, count: s.count, arity: s.arity,
        lastCaller: "0x" + s.lastCaller.toString(16), lastCallerSym: symbolize(s.lastCaller),
    })));

    /**
     * backtrace(esp?) — on-demand guest call-stack reconstruction (module-labelled,
     * deep stack scan). The pull-anytime companion to the auto exit-trace: pair it
     * with breakOnApi('kernel32:ExitProcess') to capture *who called exit* at the
     * exact moment (stack intact, before process teardown drops late logs), or call
     * it at any breakpoint / live moment. `esp` defaults to the live CPU esp.
     */
    svc.register("backtrace", (args) => {
        const esp = typeof args[0] === "number" ? (args[0] as number) >>> 0 : undefined;
        const d = proc()?.dispatcher as { getGuestCallStack?: (e?: number) => {
            esp: number; lastThunk: string; recent: string[];
            frames: Array<{ index: number; stackOffset: number; retAddr: number; moduleName: string | null; moduleOffset: number; isThunk: boolean }>;
        } } | undefined;
        if (!d?.getGuestCallStack) {
            throw new HarnessError("dispatcher/getGuestCallStack unavailable (no process loaded?)", HarnessErrorCode.BAD_ARGS);
        }
        const bt = d.getGuestCallStack(esp);
        return {
            esp: "0x" + bt.esp.toString(16),
            lastThunk: bt.lastThunk,
            recent: bt.recent,
            frames: bt.frames.map((f) => ({
                i: f.index,
                ret: "0x" + f.retAddr.toString(16),
                mod: f.moduleName ? `${f.moduleName}+0x${f.moduleOffset.toString(16)}` : null,
                sym: symbolize(f.retAddr),
                isThunk: f.isThunk,
            })),
        };
    });

    /** strcapStart() / strcapDump(top=60) — tally the string PAIRS passed to msvcrt
     *  strcmp/_stricmp/_strnicmp/_strcmpi (narrow) and wcscmp/_wcsicmp/wcsstr (wide) between
     *  the two calls. Reveals what NAMES the engine compares (e.g. UClass resolution by name) —
     *  catch a corrupted/never-matched class name. Unlike dbg.strcap this is tick-driven (no
     *  host timer): start → tickFrames → dump. */
    const msvcrtMod = () => proc()?.getModule?.("msvcrt") as
        { dbgStrCapStart?: () => void; dbgStrCapDump?: (top: number) => unknown; dbgStrCapStop?: () => void } | undefined;
    svc.register("strcapStart", () => {
        const m = msvcrtMod();
        if (!m?.dbgStrCapStart) throw new HarnessError("msvcrt strcap unavailable (no process?)", HarnessErrorCode.BAD_ARGS);
        m.dbgStrCapStart();
        return { started: true };
    });
    svc.register("strcapDump", (args) => {
        const m = msvcrtMod();
        if (!m?.dbgStrCapDump) throw new HarnessError("msvcrt strcap unavailable (no process?)", HarnessErrorCode.BAD_ARGS);
        const out = m.dbgStrCapDump(typeof args[0] === "number" ? (args[0] as number) : 60);
        m.dbgStrCapStop?.();
        return out;
    });

    /** Recent harness events (for post-hoc inspection / debugging the bus). */
    svc.register("events", (args) => {
        const count = typeof args[0] === "number" ? (args[0] as number) : 64;
        const name = typeof args[1] === "string" ? (args[1] as string) : undefined;
        return harnessBus.recent(count, name);
    });

    /**
     * faults(n?) — the last n guest page faults (EIP, fault address, owning thread,
     * last WinAPI thunk, live registers). Durable across the log firehose and
     * zero-perturbation — the go-to verb when the emulator "froze": it shows where
     * a thread derailed (near-NULL deref / wild jump) instead of leaving a hang.
     */
    svc.register("faults", (args) => {
        const n = typeof args[0] === "number" ? (args[0] as number) : 16;
        const hx = (v: number) => "0x" + (v >>> 0).toString(16);
        return faultRecorder.recent(n).map((f) => ({
            ts: Math.round(f.ts),
            eip: hx(f.eip),
            faultAddr: hx(f.faultAddr),
            errorCode: hx(f.errorCode),
            write: !!(f.errorCode & 0x2),
            threadId: f.threadId,
            lastThunk: f.lastThunk,
            kind: f.kind,
            // false ⇒ no instruction at `eip` addresses CR2; the jit only materializes
            // eip's low 12 bits, so read CR2/cr2Candidates instead of chasing that EIP.
            eipTrusted: f.eipTrusted,
            cr2Candidates: f.cr2Candidates,
            badCall: f.badCall,
            outcome: f.outcome,
            regs: {
                eax: f.regs.eax !== undefined ? hx(f.regs.eax) : undefined,
                ecx: hx(f.regs.ecx),
                edx: f.regs.edx !== undefined ? hx(f.regs.edx) : undefined,
                ebx: hx(f.regs.ebx), esp: hx(f.regs.esp),
                ebp: hx(f.regs.ebp), esi: hx(f.regs.esi), edi: hx(f.regs.edi),
            },
            recentCalls: f.recentCalls,
            gameEsp: hx(f.gameEsp),
            stackDump: f.stackDump.map((w, i) => `[+0x${(i * 4).toString(16)}] ${hx(w)}`),
        }));
    });
}
