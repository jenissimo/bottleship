/**
 * JS-side write trap — the counterpart to MemWriteTrap.
 *
 * MemWriteTrap can only see GUEST stores: it works by protecting pages and catching
 * the #PF. A write performed by JS through {@link Mem} raises no fault, so the MMU
 * trap reports zero hits for it — and that is indistinguishable from "nobody wrote
 * here". This trap closes exactly that hole: every `Mem` write offers itself here, so
 * an armed range answers "which of OUR handlers wrote into this block".
 *
 * Designed so it cannot lie about its own coverage — the project's dominant bug class
 * is an instrument reporting a plausible number while measuring something other than
 * its label:
 *   - `armed`/`base`/`end` are echoed back, so a report can be tied to a range.
 *   - `inspected` counts EVERY write offered while armed, not just matches. A run that
 *     inspected 0 writes (hook not reached, trap armed after the fact, guest never in
 *     JS) is therefore distinguishable from a run where writes happened and none
 *     matched.
 *   - `blindSpots` names, in the report itself, the write paths this trap CANNOT see,
 *     so a null result is never mistaken for proof that no JS wrote the range.
 *
 * Each hit records the in-flight thunk (which WinAPI/CRT export was executing), the
 * guest EIP/ESP at the time, the byte length, the first bytes written, and the JS call
 * stack — the stack is what turns "something wrote here" into "this function wrote
 * here".
 *
 * Diagnostic only. Arm via the harness (`trapJsWrites`), never on a hot path.
 */

import { System } from "../system";

const MAX_HITS = 128;
const MAX_BYTES_RECORDED = 32;

export interface JsWriteHit {
    /** Order of observation (1-based). */
    seq: number;
    /** Start address of the write (may precede the armed range — see `len`). */
    addr: number;
    /** Byte length of the write. */
    len: number;
    /** First bytes written, hex (truncated to MAX_BYTES_RECORDED); '' when the
     *  caller passed a scalar instead of a buffer (see `value`). */
    bytes: string;
    /** Scalar written, when the write was a writeUintN/writeFloatN. */
    value: number | null;
    /** ASCII rendering of `bytes` — a path/name writer is recognisable at a glance. */
    ascii: string;
    /** Name of the WinAPI/CRT thunk in flight ('' when JS ran outside a thunk). */
    thunk: string;
    /** Guest EIP / ESP at the time of the write (raw; the harness symbolises). */
    eip: number;
    esp: number;
    /** Trimmed JS call stack — the JS-side writer. */
    jsStack: string[];
    /** Module-labelled GUEST call stack — names the game code that asked for the write,
     *  which is what a `memcpy`/`strcpy` hit needs (the JS stack only says "memcpy"). */
    guestStack: string[];
}

class JsWriteTrap {
    private armed = false;
    private lo = 0;
    private hi = 0;
    private label = "";
    private inspected = 0;
    private matched = 0;
    private hits: JsWriteHit[] = [];
    /** Re-entrancy guard: capturing context must never recurse into Mem. */
    private inNote = false;

    arm(addr: number, len: number, label = ""): { armed: boolean; base: number; end: number; label: string } {
        this.lo = addr >>> 0;
        this.hi = (addr + Math.max(1, len | 0)) >>> 0;
        this.label = label;
        this.inspected = 0;
        this.matched = 0;
        this.hits = [];
        this.armed = true;
        return { armed: true, base: this.lo, end: this.hi, label };
    }

    disarm(): { armed: boolean } {
        this.armed = false;
        return { armed: false };
    }

    isArmed(): boolean {
        return this.armed;
    }

    /**
     * Offered by every {@link Mem} write. Hot path: one field read when disarmed.
     * `data` is the buffer for byte writes, or the scalar for writeUintN/writeFloatN.
     */
    note(address: number, size: number, data?: number | Uint8Array): void {
        if (!this.armed) return;
        this.inspected++;
        const addr = address >>> 0;
        const end = (addr + (size | 0)) >>> 0;
        if (addr >= this.hi || end <= this.lo) return;      // no overlap with the armed range
        this.matched++;
        if (this.hits.length >= MAX_HITS || this.inNote) return;
        this.inNote = true;
        try {
            this.hits.push(this.capture(addr, size, data));
        } catch {
            /* a diagnostic must never take the process down */
        } finally {
            this.inNote = false;
        }
    }

    private capture(addr: number, size: number, data?: number | Uint8Array): JsWriteHit {
        let bytes = "";
        let ascii = "";
        let value: number | null = null;
        if (data instanceof Uint8Array) {
            const n = Math.min(data.length, MAX_BYTES_RECORDED);
            for (let i = 0; i < n; i++) {
                const b = data[i]!;
                bytes += b.toString(16).padStart(2, "0");
                ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
            }
        } else if (typeof data === "number") {
            value = data >>> 0;
        }

        let thunk = "";
        let eip = 0;
        let esp = 0;
        let guestStack: string[] = [];
        try {
            const p: any = System.getInstance().process;
            const disp: any = p?.dispatcher;
            thunk = disp?.getCurrentThunkName?.() ?? "";
            const c: any = p?.v86?.cpu ?? p?.v86?.v86?.cpu ?? null;
            eip = (c?.instruction_pointer?.[0] ?? 0) >>> 0;
            esp = (c?.reg32?.[4] ?? 0) >>> 0;
            const gs = disp?.getGuestCallStack?.(undefined, 0x400, 10);
            guestStack = (gs?.frames ?? []).map((f: any) =>
                f.moduleName
                    ? `${f.moduleName}+0x${(f.moduleOffset >>> 0).toString(16)}${f.isThunk ? " (thunk)" : ""}`
                    : `0x${(f.retAddr >>> 0).toString(16)}`);
        } catch { /* best effort */ }

        return {
            seq: this.matched, addr, len: size | 0, bytes, ascii, value,
            thunk, eip, esp,
            jsStack: trimStack(new Error().stack),
            guestStack,
        };
    }

    report(): {
        armed: boolean; label: string; base: string; end: string;
        inspected: number; matched: number; hits: JsWriteHit[];
        blindSpots: string[];
    } {
        return {
            armed: this.armed,
            label: this.label,
            base: "0x" + this.lo.toString(16),
            end: "0x" + this.hi.toString(16),
            inspected: this.inspected,
            matched: this.matched,
            hits: this.hits,
            // Named in the report on purpose: `matched === 0` only exonerates the paths
            // that actually funnel through Mem. These do not, and a null result says
            // nothing about them.
            blindSpots: [
                "WASM hypercall handlers (memcpy/memset/strcpy/wcscpy/wcscat/wcsncpy, " +
                "HeapAlloc/HeapFree slab) write guest memory from Rust — invisible here " +
                "AND to MemWriteTrap. Force them to the JS fallback with " +
                "wasmStringWriters(false) before trusting a null result.",
                "Legacy modules that index mem8[...] directly instead of using Mem " +
                "(CLAUDE.md §3.1 requires Mem in new/changed code, but older call sites exist).",
                "Guest CPU stores — that is MemWriteTrap's job (trapWrites).",
            ],
        };
    }
}

/** Keep the frames that name our code; drop the trap's own and the Mem plumbing. */
function trimStack(stack: string | undefined): string[] {
    if (!stack) return [];
    return stack
        .split("\n")
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => !/js-write-trap|mem-accessor|at Error/.test(l))
        .slice(0, 12);
}

export const jsWriteTrap = new JsWriteTrap();
