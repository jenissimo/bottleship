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
 * wasm logged.
 */

import { harnessBus } from "./event-bus";
import { faultSnapshot, proc, cpu, guestMem } from "./serialize";
import { dbg } from "../core/debug/dbg-commands";

/**
 * Optional arg/stack predicate for a conditional breakpoint. Evaluated at the armed eip — which the
 * wasm logs synchronously BEFORE executing that instruction, so at a function ENTRY eip the stack is
 * the caller's: [ESP]=return addr, [ESP+4]=arg0, [ESP+4+i*4]=arg i (cdecl/stdcall). The break only
 * fires (pauses/resolves) when the predicate holds; otherwise it counts the hit and execution
 * continues. Lets you catch e.g. `core!StaticConstructObject` only when its class arg is NULL, instead
 * of stopping on all hundreds of constructs.
 */
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
    when?: BreakWhen;
    onHit?: (snapshot: unknown) => void;
    hits: number;
}

// "eip=0x00401000 <BP>" — the eip immediately precedes the <BP> tag (cpu.rs format).
const BP_LINE = /eip=0x([0-9a-fA-F]{8}) <BP>/;

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

    arm(eip: number, opts: { runId?: number | null; once?: boolean; pause?: boolean; when?: BreakWhen; onHit?: (s: unknown) => void } = {}): number {
        this.ensureInterceptor();
        const id = this.nextId++;
        this.entries.push({
            id,
            eip: eip >>> 0,
            runId: opts.runId ?? null,
            once: opts.once ?? true,
            pause: opts.pause ?? true,
            when: opts.when,
            onHit: opts.onHit,
            hits: 0,
        });
        return id;
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
            const snap = faultSnapshot();
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
