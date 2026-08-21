/**
 * Awaitable EIP breakpoints. The wasm interpreter's dbg_on_instruction
 * does NOT call back into JS or stop the CPU on a hit — it only formats a
 * "[DBG] … eip=0x……… <BP> …" line and routes it to console.error (vendor/v86
 * dbg.rs -> starter.js console_log_from_wasm). So we make EIP breakpoints
 * awaitable by intercepting that console.error line: on a <BP> match we capture
 * the fault-grade snapshot, emit breakHit, and (by default) stop the v86 loop so
 * the state stays inspectable.
 *
 * BLOCK ENTRIES ONLY — the limit that makes a silent breakpoint possible.
 * dbg_on_instruction runs once per cycle_internal, i.e. once per v86 BLOCK, not per
 * instruction, and v86 ends a block at call/ret/out/int/far or page-crossing control
 * flow — a plain jmp/jcc does NOT end one. An address that is not a block entry NEVER
 * fires, with JIT off exactly as with `fast:true` (measured: a bp on a stub's first
 * instruction fired 5/5 calls, one byte later 0/5 in both modes). So a breakpoint on a
 * store or any mid-function instruction — the "known writer" shape — reports nothing
 * while the code runs. Arm the enclosing function's ENTRY, or use trapWrites for a
 * data question. `hits: 0` here is never evidence that the code did not execute.
 *
 * It is NOT instruction-precise pausing — execution may advance a few
 * instructions between the log and our v86.stop(); breakHit reports the eip the
 * wasm logged. The SNAPSHOT, however, is precise: the wasm calls the log import
 * synchronously before executing the armed instruction, so the registers and the
 * stack we read in the interceptor are the ones at that instruction — which is what
 * makes `callsite.retAddr` meaningful at a function entry.
 *
 * Every hit carries `callsite` (retAddr + a trust verdict + the module-labelled
 * backtrace + a stack window + requested register-relative reads) in EVERY mode,
 * continuous included, and is pushed to the worker-side ring (break-events.ts) so a
 * dying reader cannot take the evidence with it.
 */

import { harnessBus } from "./event-bus";
import { faultSnapshot, proc, cpu, guestMem, symbolize } from "./serialize";
import { breakEvents } from "./break-events";
import { dbg } from "../core/debug/dbg-commands";

/**
 * Optional arg/stack predicate for a conditional breakpoint. Evaluated at the armed eip — which the
 * wasm logs synchronously BEFORE executing that instruction, so at a function ENTRY eip the stack is
 * the caller's: [ESP]=return addr, [ESP+4]=arg0, [ESP+4+i*4]=arg i (cdecl/stdcall). The break only
 * fires (pauses/resolves) when the predicate holds; otherwise it counts the hit and execution
 * continues. Lets you catch e.g. `core!StaticConstructObject` only when its class arg is NULL, instead
 * of stopping on all hundreds of constructs.
 */
/**
 * What to read AT the hit. The stack only belongs to the caller for the instant the wasm logs
 * the armed eip, and nothing after the run resumes can recover it — a post-hoc `readBytes` races
 * the guest and silently returns a half-overwritten frame (or zeros), which is indistinguishable
 * from a wrong offset. So the reads are declared up front and settled synchronously here.
 */
export interface BreakCapture {
    /** Dump this many cdecl/stdcall args from [ESP+4+i*4] (or [EBP+8+i*4] with `ebp`). */
    args?: number;
    /** Read `ebp:true`-style, for a bp that lands after PUSH EBP; MOV EBP,ESP. */
    ebp?: boolean;
    /** Dereference an arg: read `len` bytes at (arg[i] + offset). A NULL arg is reported as such
     *  rather than read, so "pointer was NULL" never masquerades as "field was zero". */
    follow?: Array<{ arg: number; offset?: number; len: number; label?: string }>;
    /** Register-relative reads settled AT the hit: address = reg + offset, or *(reg + offset)
     *  with `deref`. `size` bytes (default 4) come back as hex, plus `u32` when size is 4.
     *  The minimal answer to "record [esi+0x0c] on every hit" — deliberately not an
     *  expression language. An unknown register is an ERROR entry, never a zero. */
    reads?: Array<{ reg: string; offset?: number; size?: number; deref?: boolean; label?: string }>;
    /** Frames of module-labelled guest call stack (default 12). `false`/0 opts out — the only
     *  reason to is a very hot continuous bp, where the stack scan runs per hit. */
    backtrace?: boolean | number;
    /** Raw dwords from [ESP] upward (default 8). */
    stack?: number;
}

/** Register file order in v86's reg32. */
const REG_INDEX: Record<string, number> = { eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7 };

export interface BreakWhen {
    /** Argument index (0-based). By default read from [ESP + 4 + arg*4] (entry convention).
     *  With `ebp:true`, read from [EBP + 8 + arg*4] — use this when the wasm advances past the
     *  prologue (PUSH EBP; MOV EBP,ESP) before the snapshot, which shifts ESP but leaves args at
     *  [EBP+8] (the stdcall/cdecl frame). */
    arg: number;
    /** Read the arg relative to EBP ([EBP+8+arg*4]) instead of ESP — for post-prologue bp hits. */
    ebp?: boolean;
    /** Fire only when the arg equals this u32. */
    eq?: number;
    /** Fire only when the arg does NOT equal this u32. */
    ne?: number;
}

interface EipBreakEntry {
    id: number;
    eip: number;
    runId: number | null;
    once: boolean;
    pause: boolean;
    capture?: BreakCapture;
    when?: BreakWhen;
    /** Build the call-site evidence + ring record on every hit (default true). `captureAt`
     *  turns it off: it has its own recorder and arms deliberately hot addresses, where the
     *  per-hit stack scan would be the dominant cost. */
    callsite: boolean;
    onHit?: (snapshot: unknown) => void;
    hits: number;
}

// "eip=0x00401000 <BP>" — the eip immediately precedes the <BP> tag (cpu.rs format).
const BP_LINE = /eip=0x([0-9a-fA-F]{8}) <BP>/;

const hx = (n: number): string => "0x" + (n >>> 0).toString(16);

/**
 * Is [ESP] actually a RETURN ADDRESS — i.e. is the armed eip a function ENTRY?
 *
 * The whole "who called this" answer rests on that assumption and nothing else
 * checks it: at a mid-function block entry (after a call returns, at a loop head
 * v86 chose to start a block at) [ESP] is a local, and reporting it as `retAddr`
 * hands back a plausible address that names nobody. So verify it against the guest's
 * own code: a real return address is preceded by the CALL that produced it.
 *   verified  — E8 rel32 immediately before, and its target IS the armed eip.
 *   plausible — a call instruction is there (indirect, or direct to another target:
 *               a jmp thunk / a bp on an export forwarder legitimately looks like this).
 *   untrusted — no call precedes it; treat retAddr as noise, not as the caller.
 */
function analyzeRetAddr(mem: Uint8Array, ret: number, armedEip: number): {
    verdict: "verified" | "plausible" | "untrusted" | "unreadable";
    callKind: string | null;
    callTarget: string | null;
    note?: string;
} {
    const r = ret >>> 0;
    if (r < 8 || r + 1 > mem.length) {
        return { verdict: "unreadable", callKind: null, callTarget: null, note: "[ESP] is outside guest memory — not a code address" };
    }
    // E8 rel32: the call ends exactly at `ret`, so target = ret + rel32.
    if (mem[r - 5] === 0xe8) {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const target = (r + view.getInt32(r - 4, true)) >>> 0;
        if (target === (armedEip >>> 0)) {
            return { verdict: "verified", callKind: "E8 rel32", callTarget: hx(target) };
        }
        return {
            verdict: "plausible", callKind: "E8 rel32", callTarget: hx(target),
            note: `the call before [ESP] targets ${hx(target)}, not the armed eip ${hx(armedEip)} — legitimate through a jmp thunk/forwarder, but the armed address may also not be the entry that was called`,
        };
    }
    // Indirect / far call: FF /2 (call r/m32), FF /3 (call far), 9A ptr16:32.
    for (let len = 2; len <= 7; len++) {
        const b = mem[r - len];
        if (b === 0xff) {
            const reg = (mem[r - len + 1]! >>> 3) & 7;
            if (reg === 2 || reg === 3) {
                return { verdict: "plausible", callKind: `FF /${reg} (indirect call, ${len} bytes)`, callTarget: null };
            }
        }
        if (len === 7 && b === 0x9a) return { verdict: "plausible", callKind: "9A far call", callTarget: null };
    }
    return {
        verdict: "untrusted", callKind: null, callTarget: null,
        note: "no CALL instruction precedes [ESP] — the armed eip is very likely NOT a function entry " +
            "(v86 also starts a block after a call returns and at some jump targets). retAddr does NOT name the caller here.",
    };
}

class EipBreakRegistry {
    private entries: EipBreakEntry[] = [];
    private nextId = 1;
    private installed = false;

    private ensureInterceptor(): void {
        if (this.installed) return;
        this.installed = true;
        const orig = console.error.bind(console);
        const reg = this;
        console.error = (...args: unknown[]) => {
            orig(...args);
            if (!reg.entries.length) return;
            const first = args[0];
            if (typeof first === "string" && first.indexOf("<BP>") !== -1) {
                const m = BP_LINE.exec(first);
                if (m) reg.onHit(parseInt(m[1], 16) >>> 0);
            }
        };
    }

    arm(eip: number, opts: { runId?: number | null; once?: boolean; pause?: boolean; when?: BreakWhen; capture?: BreakCapture; callsite?: boolean; onHit?: (s: unknown) => void } = {}): number {
        this.ensureInterceptor();
        const id = this.nextId++;
        this.entries.push({
            id,
            eip: eip >>> 0,
            runId: opts.runId ?? null,
            once: opts.once ?? true,
            pause: opts.pause ?? true,
            capture: opts.capture,
            when: opts.when,
            callsite: opts.callsite !== false,
            onHit: opts.onHit,
            hits: 0,
        });
        return id;
    }

    /** Settle a BreakCapture against the live CPU/stack. Callers get hex, never a parsed guess. */
    private evalCapture(capture: BreakCapture): unknown {
        const c = cpu();
        const mem = guestMem();
        if (!mem || !c?.reg32) return { error: "no cpu/guest memory at hit" };
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const base = capture.ebp ? ((c.reg32[5] >>> 0) + 8) >>> 0 : ((c.reg32[4] >>> 0) + 4) >>> 0;
        const u32 = (addr: number): number | null =>
            addr >= 4 && addr + 4 <= mem.length ? view.getUint32(addr, true) >>> 0 : null;
        const hex = (addr: number, len: number): string | null => {
            if (addr < 4 || addr + len > mem.length) return null;
            let out = "";
            for (let i = 0; i < len; i++) out += mem[addr + i].toString(16).padStart(2, "0");
            return out;
        };
        const args: Array<string | null> = [];
        const argsAsked = capture.args ?? 0;
        const followAsked = (capture.follow ?? []).length;
        for (let i = 0; i < Math.min(argsAsked, 16); i++) {
            const v = u32((base + i * 4) >>> 0);
            args.push(v === null ? null : "0x" + v.toString(16));
        }
        const follow: unknown[] = [];
        for (const f of (capture.follow ?? []).slice(0, 24)) {
            const ptr = u32((base + (f.arg | 0) * 4) >>> 0);
            const label = f.label ?? `arg${f.arg}+0x${(f.offset ?? 0).toString(16)}`;
            if (ptr === null) { follow.push({ label, error: "arg slot out of range" }); continue; }
            if (ptr === 0) { follow.push({ label, ptr: "0x0", error: "pointer is NULL — not read" }); continue; }
            const at = (ptr + (f.offset ?? 0)) >>> 0;
            const len = Math.min(Math.max(f.len | 0, 1), 4096);
            const h = hex(at, len);
            follow.push(h === null
                ? { label, ptr: "0x" + ptr.toString(16), at: "0x" + at.toString(16), error: "out of guest range" }
                : { label, ptr: "0x" + ptr.toString(16), at: "0x" + at.toString(16), len, hex: h });
        }
        // A silently short answer reads as "the guest had nothing there".
        const truncated = argsAsked > args.length || followAsked > follow.length
            ? { truncated: { argsAsked, argsReturned: args.length, followAsked, followReturned: follow.length } }
            : {};
        return {
            convention: capture.ebp ? "[EBP+8+i*4]" : "[ESP+4+i*4]",
            esp: "0x" + (c.reg32[4] >>> 0).toString(16), args, follow, ...truncated,
        };
    }

    /**
     * The "who called this, and with what" half of a hit — the same evidence an API-break
     * snapshot carries (readCallSnapshot), settled here for EIP breaks in EVERY mode,
     * continuous included. Everything is read synchronously at the hit instant: the wasm logs
     * the armed eip BEFORE executing it, so this is the caller's frame, and nothing after the
     * guest resumes can recover it.
     */
    private buildCallsite(armedEip: number, capture?: BreakCapture): unknown {
        const c = cpu();
        const mem = guestMem();
        if (!mem || !c?.reg32) return { error: "no cpu/guest memory at hit" };
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const rU = (a: number): number | null => (a >>> 0) >= 4 && (a >>> 0) + 4 <= mem.length ? view.getUint32(a >>> 0, true) >>> 0 : null;
        const esp = c.reg32[4] >>> 0;
        const liveEip = (c.instruction_pointer?.[0] ?? 0) >>> 0;

        const ret = rU(esp);
        const trust = ret === null
            ? { verdict: "unreadable" as const, callKind: null, callTarget: null, note: "ESP is outside guest memory" }
            : analyzeRetAddr(mem, ret, armedEip);

        // Stack window from [ESP] up (arg 0 is at [ESP+4] at an entry).
        const nStack = Math.min(Math.max(capture?.stack ?? 8, 0), 64);
        const stack: string[] = [];
        for (let i = 0; i < nStack; i++) {
            const v = rU((esp + i * 4) >>> 0);
            stack.push(`[ESP+0x${(i * 4).toString(16)}]=${v === null ? "?" : hx(v)}`);
        }

        // Module-labelled backtrace — the SAME reconstruction `backtrace` and the API-break
        // snapshot use (dispatcher.getGuestCallStack); no second unwinder.
        const btWant = capture?.backtrace === undefined ? 12 : (capture.backtrace === true ? 12 : capture.backtrace === false ? 0 : capture.backtrace | 0);
        let backtrace: unknown[] | null = null;
        let backtraceNote: string | undefined;
        if (btWant > 0) {
            try {
                const bt = (proc()?.dispatcher as any)?.getGuestCallStack?.(esp, 0x800, btWant);
                const frames: any[] = bt?.frames ?? [];
                if (!frames.length) backtraceNote = "dispatcher.getGuestCallStack returned no frames (no cached guest memory yet?) — NOT 'the stack was empty'";
                else backtrace = frames.map((f: any) => ({
                    i: f.index, ret: hx(f.retAddr),
                    mod: f.moduleName ? `${f.moduleName}+0x${(f.moduleOffset >>> 0).toString(16)}` : null,
                    sym: symbolize(f.retAddr), isThunk: f.isThunk,
                }));
            } catch (e) {
                backtraceNote = "getGuestCallStack threw: " + String(e);
            }
        }

        // Arbitrary register-relative reads (`capture.reads`).
        const reads: unknown[] = [];
        for (const s of (capture?.reads ?? []).slice(0, 32)) {
            const label = s.label ?? `${s.reg}+0x${(s.offset ?? 0).toString(16)}${s.deref ? "*" : ""}`;
            const ri = REG_INDEX[String(s.reg).toLowerCase()];
            if (ri === undefined) { reads.push({ label, error: `unknown register '${s.reg}' (eax/ecx/edx/ebx/esp/ebp/esi/edi)` }); continue; }
            const base = ((c.reg32[ri] >>> 0) + ((s.offset ?? 0) | 0)) >>> 0;
            let addr = base;
            let via: string | undefined;
            if (s.deref) {
                const p = rU(base);
                if (p === null) { reads.push({ label, base: hx(base), error: "deref source out of guest range" }); continue; }
                if (p === 0) { reads.push({ label, base: hx(base), ptr: "0x0", error: "pointer is NULL — not read" }); continue; }
                via = hx(base); addr = p;
            }
            const size = Math.min(Math.max((s.size ?? 4) | 0, 1), 4096);
            if (addr < 4 || addr + size > mem.length) { reads.push({ label, addr: hx(addr), via, error: "out of guest range" }); continue; }
            let hex = "";
            for (let i = 0; i < size; i++) hex += mem[addr + i]!.toString(16).padStart(2, "0");
            reads.push({ label, addr: hx(addr), via, size, hex, u32: size === 4 ? hx(view.getUint32(addr, true) >>> 0) : undefined });
        }

        return {
            armedEip: hx(armedEip),
            eip: hx(liveEip),
            // A snapshot taken anywhere but the armed instruction invalidates the whole frame reading.
            ...(liveEip === (armedEip >>> 0) ? {} : { eipMismatch: `cpu eip ${hx(liveEip)} != armed ${hx(armedEip)} — the snapshot is NOT at the break instant; every value below is suspect` }),
            esp: hx(esp),
            retAddr: ret === null ? null : hx(ret),
            retAddrSym: ret === null ? null : symbolize(ret),
            retAddrTrust: trust,
            // Independent cross-check inside the tool: the stack WALKER's first frame vs the
            // raw [ESP] read. Disagreement means one of the two is looking at the wrong frame.
            retAddrInBacktrace: backtrace ? (backtrace as any[]).some((f) => f.ret === (ret === null ? null : hx(ret))) : null,
            regs: {
                eax: hx(c.reg32[0]), ecx: hx(c.reg32[1]), edx: hx(c.reg32[2]), ebx: hx(c.reg32[3]),
                esp: hx(c.reg32[4]), ebp: hx(c.reg32[5]), esi: hx(c.reg32[6]), edi: hx(c.reg32[7]),
            },
            stack,
            backtrace, ...(backtraceNote ? { backtraceNote } : {}),
            // Measured on a real title: between the hit and the pause taking effect the guest
            // ran on far enough that a `backtrace()` pulled afterwards described an unrelated
            // stack. Everything above is from the hit instant; nothing read later is.
            note: "read AT the hit. `pause` is not instruction-precise — a backtrace()/readBytes issued after the break describes a LATER moment, not this one.",
            ...(reads.length ? { reads } : {}),
        };
    }

    /** Evaluate a conditional-break predicate against the live CPU/stack at the armed eip. */
    private evalWhen(when: BreakWhen): boolean {
        const c = cpu();
        const mem = guestMem();
        if (!mem || !c?.reg32) return false;
        const addr = when.ebp
            ? ((c.reg32[5] >>> 0) + 8 + (when.arg | 0) * 4) >>> 0   // [EBP+8+i*4] — post-prologue frame
            : ((c.reg32[4] >>> 0) + 4 + (when.arg | 0) * 4) >>> 0;  // [ESP+4+i*4] — entry convention
        if (addr < 4 || addr + 4 > mem.length) return false;
        const val = new DataView(mem.buffer, mem.byteOffset, mem.byteLength).getUint32(addr, true) >>> 0;
        if (when.eq !== undefined && val !== (when.eq >>> 0)) return false;
        if (when.ne !== undefined && val === (when.ne >>> 0)) return false;
        return true;
    }

    disarm(id: number): void {
        this.entries = this.entries.filter((e) => e.id !== id);
    }

    clear(): number {
        const n = this.entries.length;
        this.entries = [];
        return n;
    }

    list(): Array<{ id: number; eip: number; hits: number; once: boolean }> {
        return this.entries.map((e) => ({ id: e.id, eip: e.eip, hits: e.hits, once: e.once }));
    }

    private onHit(eip: number): void {
        for (const e of [...this.entries]) {
            if (e.eip !== eip) continue;
            e.hits++;
            // Conditional break: skip (keep running) until the arg/stack predicate holds.
            if (e.when && !this.evalWhen(e.when)) continue;
            // The call-site evidence is built FIRST and in every mode (continuous included) —
            // it is the "who called this" half the API-break snapshot always carried and the
            // EIP path did not, and it must be read before anything else can perturb the frame.
            const callsite = e.callsite ? this.buildCallsite(eip, e.capture) : null;
            const snap = faultSnapshot() as Record<string, unknown>;
            if (callsite) snap.callsite = callsite;
            if (e.capture) snap.captured = this.evalCapture(e.capture);
            // Land in the worker-side ring before the event: a reader dying at its timeout
            // must not take the run's evidence with it (read back with `breakEvents`).
            if (e.callsite) {
                snap.breakEventSeq = breakEvents.push("eip", e.id, hx(eip), { hit: e.hits, callsite, captured: snap.captured });
            }
            harnessBus.emit("breakHit", snap, e.runId);
            if (e.pause) {
                // Canonical pause (sets module-level isPaused) so the break actually
                // holds — a bare v86.stop() is undone by the 1ms scheduler.
                try { (globalThis as any).__harnessPause?.() ?? proc()?.v86?.stop?.(); } catch { /* */ }
            }
            e.onHit?.(snap);
            if (e.once) this.disarm(e.id);
        }
        // When the last entry auto-disarms, clear the wasm interpreter breakpoints
        // too — the wasm has no per-bp removal, so it would keep logging "<BP>" on
        // every pass and spamming console.error. (JIT stays off until reload /
        // dbg.jitOn(); see clearBreaks.)
        if (this.entries.length === 0) {
            try { dbg.clear(); } catch { /* */ }
        }
    }
}

export const eipBreaks = new EipBreakRegistry();
