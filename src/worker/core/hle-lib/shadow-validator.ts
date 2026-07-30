/**
 * Guarded Inner-Loop HLE — differential shadow validator.
 *
 * Every shadow-enabled hook goes through a per-hook state machine:
 *
 *   'shadowing'  first N calls: the kernel runs against SCRATCH copies of its
 *                declared output ranges (guest memory untouched), then the
 *                ORIGINAL guest function runs via the relocated-prologue
 *                trampoline and stays authoritative. At return the two are
 *                compared — return EAX + every byte of every declared range.
 *   'active'     N clean calls later: the kernel runs against LIVE guest
 *                memory; the original is no longer invoked. Zero shadow cost.
 *   'disabled'   any mismatch (or kernel throw / out-of-contract write):
 *                structured report, permanent unpatch — the guest's own code
 *                runs for the rest of the session. Fallback is never removed.
 *
 * The original-call path reuses the proven suspended-thunk + invokeCallback
 * machinery (the DispatchMessage/EnumWindows pattern): the hook's stub thunk
 * suspends, the trampoline address is invoked as a "callback", and the
 * completeThunk lambda performs the comparison and hands the guest's own EAX
 * back to the real caller.
 *
 * Comparison + view plumbing are pure and unit-tested (tools/tests).
 */

import { Logger, LogCategory } from '../logger';
import type {
    ShadowHookState,
    ShadowHookStatus,
    ShadowRange,
    ShadowSpec,
    ShadowView,
} from './types';

// ─── Views ───────────────────────────────────────────────────────────────────

/** Production view: reads and writes go straight to guest memory. */
export class LiveShadowView implements ShadowView {
    private view: DataView;
    constructor(private mem: Uint8Array) {
        this.view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    }
    readU8(a: number): number { return this.mem[a]; }
    readU16(a: number): number { return this.view.getUint16(a, true); }
    readU32(a: number): number { return this.view.getUint32(a, true) >>> 0; }
    readF32(a: number): number { return this.view.getFloat32(a, true); }
    readF64(a: number): number { return this.view.getFloat64(a, true); }
    readBytes(a: number, len: number): Uint8Array { return this.mem.subarray(a, a + len); }
    writeU8(a: number, v: number): void { this.mem[a] = v & 0xFF; }
    writeU16(a: number, v: number): void { this.view.setUint16(a, v & 0xFFFF, true); }
    writeU32(a: number, v: number): void { this.view.setUint32(a, v >>> 0, true); }
    writeF32(a: number, v: number): void { this.view.setFloat32(a, v, true); }
    writeF64(a: number, v: number): void { this.view.setFloat64(a, v, true); }
    writeBytes(a: number, bytes: Uint8Array): void { this.mem.set(bytes, a); }
}

/**
 * Validation view: reads hit the scratch overlay inside declared ranges
 * (pre-call copies, possibly already kernel-written) and live guest memory
 * outside; writes MUST land inside a declared range — anything else is an
 * out-of-contract write and fails the call loudly.
 */
export class ScratchShadowView implements ShadowView {
    readonly scratch: Uint8Array[];
    /** Set when the kernel wrote outside its declared ranges. */
    outOfContractWrite: string | null = null;
    private liveView: DataView;

    constructor(private mem: Uint8Array, private ranges: ShadowRange[]) {
        this.liveView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        this.scratch = ranges.map(r => mem.slice(r.addr, r.addr + r.len));
    }

    private locate(addr: number, len: number): { idx: number; off: number } | null {
        for (let i = 0; i < this.ranges.length; i++) {
            const r = this.ranges[i];
            if (addr >= r.addr && addr + len <= r.addr + r.len) return { idx: i, off: addr - r.addr };
        }
        return null;
    }

    readU8(a: number): number {
        const hit = this.locate(a, 1);
        return hit ? this.scratch[hit.idx][hit.off] : this.mem[a];
    }
    readU16(a: number): number {
        const hit = this.locate(a, 2);
        if (!hit) return this.liveView.getUint16(a, true);
        const s = this.scratch[hit.idx];
        return s[hit.off] | (s[hit.off + 1] << 8);
    }
    readU32(a: number): number {
        const hit = this.locate(a, 4);
        if (!hit) return this.liveView.getUint32(a, true) >>> 0;
        const s = this.scratch[hit.idx];
        return (s[hit.off] | (s[hit.off + 1] << 8) | (s[hit.off + 2] << 16) | (s[hit.off + 3] << 24)) >>> 0;
    }
    readF32(a: number): number {
        const buf = new DataView(this.readBytes(a, 4).slice().buffer);
        return buf.getFloat32(0, true);
    }
    readF64(a: number): number {
        const buf = new DataView(this.readBytes(a, 8).slice().buffer);
        return buf.getFloat64(0, true);
    }
    readBytes(a: number, len: number): Uint8Array {
        const hit = this.locate(a, len);
        return hit ? this.scratch[hit.idx].subarray(hit.off, hit.off + len) : this.mem.subarray(a, a + len);
    }

    private failWrite(a: number, len: number): void {
        if (!this.outOfContractWrite) {
            this.outOfContractWrite =
                `kernel wrote ${len}B at 0x${a.toString(16)} outside declared ranges`;
        }
    }
    writeU8(a: number, v: number): void {
        const hit = this.locate(a, 1);
        if (!hit) return this.failWrite(a, 1);
        this.scratch[hit.idx][hit.off] = v & 0xFF;
    }
    writeU16(a: number, v: number): void {
        const hit = this.locate(a, 2);
        if (!hit) return this.failWrite(a, 2);
        const s = this.scratch[hit.idx];
        s[hit.off] = v & 0xFF; s[hit.off + 1] = (v >> 8) & 0xFF;
    }
    writeU32(a: number, v: number): void {
        const hit = this.locate(a, 4);
        if (!hit) return this.failWrite(a, 4);
        const s = this.scratch[hit.idx];
        s[hit.off] = v & 0xFF; s[hit.off + 1] = (v >> 8) & 0xFF;
        s[hit.off + 2] = (v >> 16) & 0xFF; s[hit.off + 3] = (v >>> 24) & 0xFF;
    }
    writeF32(a: number, v: number): void {
        const tmp = new DataView(new ArrayBuffer(4));
        tmp.setFloat32(0, v, true);
        this.writeBytes(a, new Uint8Array(tmp.buffer));
    }
    writeF64(a: number, v: number): void {
        const tmp = new DataView(new ArrayBuffer(8));
        tmp.setFloat64(0, v, true);
        this.writeBytes(a, new Uint8Array(tmp.buffer));
    }
    writeBytes(a: number, bytes: Uint8Array): void {
        const hit = this.locate(a, bytes.length);
        if (!hit) return this.failWrite(a, bytes.length);
        this.scratch[hit.idx].set(bytes, hit.off);
    }
}

// ─── Comparison (pure) ───────────────────────────────────────────────────────

export interface ShadowMismatch {
    kind: 'eax' | 'bytes' | 'kernel-threw' | 'out-of-contract-write' | 'sync-call-failed';
    detail: string;
}

/** ULP distance between two f32 bit patterns (monotone integer mapping). */
function f32UlpDistance(aBits: number, bBits: number): number {
    const norm = (u: number) => (u & 0x80000000 ? 0x80000000 - (u & 0x7FFFFFFF) : 0x80000000 + (u & 0x7FFFFFFF)) >>> 0;
    return Math.abs(norm(aBits >>> 0) - norm(bBits >>> 0));
}

/**
 * Compare the kernel's scratch output against live guest memory (which the
 * ORIGINAL function has just written) over the declared ranges, plus EAX.
 * Returns null when equivalent.
 */
export function compareShadowOutputs(
    mem: Uint8Array,
    ranges: ShadowRange[],
    scratch: Uint8Array[],
    kernelEax: number,
    guestEax: number,
    f32UlpTolerance?: number,
): ShadowMismatch | null {
    if ((kernelEax >>> 0) !== (guestEax >>> 0)) {
        return {
            kind: 'eax',
            detail: `EAX kernel=0x${(kernelEax >>> 0).toString(16)} guest=0x${(guestEax >>> 0).toString(16)}`,
        };
    }
    for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        const s = scratch[i];
        if (f32UlpTolerance !== undefined && r.len % 4 === 0) {
            const live = new DataView(mem.buffer, mem.byteOffset + r.addr, r.len);
            const scr = new DataView(s.buffer, s.byteOffset, r.len);
            for (let off = 0; off < r.len; off += 4) {
                const lb = live.getUint32(off, true);
                const sb = scr.getUint32(off, true);
                if (lb === sb) continue;
                const ulp = f32UlpDistance(sb, lb);
                if (ulp > f32UlpTolerance) {
                    return {
                        kind: 'bytes',
                        detail: `range[${i}] 0x${r.addr.toString(16)}+0x${off.toString(16)}: ` +
                            `kernel f32bits=0x${sb.toString(16)} guest=0x${lb.toString(16)} (${ulp} ulp > ${f32UlpTolerance})`,
                    };
                }
            }
        } else {
            for (let off = 0; off < r.len; off++) {
                if (mem[r.addr + off] !== s[off]) {
                    return {
                        kind: 'bytes',
                        detail: `range[${i}] first diff at 0x${(r.addr + off).toString(16)} (+0x${off.toString(16)}): ` +
                            `kernel=0x${s[off].toString(16)} guest=0x${mem[r.addr + off].toString(16)}`,
                    };
                }
            }
        }
    }
    return null;
}

/** Sanity-check declared ranges against guest memory bounds. */
export function rangesAreSane(ranges: ShadowRange[], memLength: number): boolean {
    if (ranges.length > 64) return false;
    for (const r of ranges) {
        if (!Number.isInteger(r.addr) || !Number.isInteger(r.len)) return false;
        if (r.addr < 0x1000 || r.len < 0 || r.len > 0x1000000) return false;
        if (r.addr + r.len > memLength) return false;
    }
    return true;
}

// ─── Per-hook state machine ──────────────────────────────────────────────────

export const SHADOW_DEFAULT_N = 128;

export class ShadowHookRuntime {
    state: ShadowHookState = 'shadowing';
    cleanCalls = 0;
    guardFails = 0;
    mismatches = 0;
    lastMismatch?: string;
    readonly targetCalls: number;

    constructor(
        readonly libId: string,
        readonly functionName: string,
        readonly spec: ShadowSpec,
        /** Permanent bail-out — restore original bytes. Set by the manager. */
        private disableHook: () => void,
        /** Fired on shadowing→active (N clean calls): the manager promotes the
         *  hook to its WASM hypercall handler here. */
        private onValidated?: () => void,
        /** Fired on active→shadowing (dbg.hleShadow re-arm): the manager must
         *  demote the WASM handler so calls flow through the JS shadow path. */
        private onRearmed?: () => void,
    ) {
        this.targetCalls = spec.n ?? SHADOW_DEFAULT_N;
    }

    status(): ShadowHookStatus {
        return {
            libId: this.libId,
            functionName: this.functionName,
            state: this.state,
            cleanCalls: this.cleanCalls,
            targetCalls: this.targetCalls,
            guardFails: this.guardFails,
            mismatches: this.mismatches,
            lastMismatch: this.lastMismatch,
        };
    }

    /** Re-arm validation (dbg.hleShadow). Disabled hooks stay disabled — the
     *  patch is gone; re-arming them needs a reload. */
    rearm(n?: number): boolean {
        if (this.state === 'disabled') return false;
        const wasActive = this.state === 'active';
        this.state = 'shadowing';
        this.cleanCalls = 0;
        if (n !== undefined) (this as { targetCalls: number }).targetCalls = n;
        if (wasActive) this.onRearmed?.();
        return true;
    }

    recordCleanCall(): void {
        this.cleanCalls++;
        if (this.cleanCalls >= this.targetCalls && this.state === 'shadowing') {
            this.state = 'active';
            Logger.log(LogCategory.SYSTEM,
                `[HLE-shadow] ${this.libId}:${this.functionName} VALIDATED — ` +
                `${this.cleanCalls} clean calls, kernel goes live`);
            this.onValidated?.();
        }
    }

    recordMismatch(m: ShadowMismatch): void {
        this.mismatches++;
        this.lastMismatch = `${m.kind}: ${m.detail}`;
        this.state = 'disabled';
        Logger.error(LogCategory.SYSTEM,
            `[HLE-shadow] ${this.libId}:${this.functionName} MISMATCH on call ` +
            `${this.cleanCalls + 1} — ${this.lastMismatch}. Hook permanently disabled; ` +
            `guest code takes over.`);
        this.disableHook();
    }

    recordGuardFail(): void {
        this.guardFails++;
    }
}
