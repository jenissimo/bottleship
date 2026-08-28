/**
 * The guest clock must never step backwards.
 *
 * QPC/GetTickCount/RDTSC are all served from the hypercall page as
 * `base + (insn_now - insn_at_update) / mips`, which is monotonic only BETWEEN publishes.
 * A guest that computes an UNSIGNED delta across a backwards step reads ~2^32 ticks, not a
 * small negative, so a millisecond of regression is indistinguishable from a huge elapsed time.
 *
 * These drive the real publisher (HypercallDataManager) and the real clock owner
 * (TimeService), because the invariant lives in their interaction: the floor is computed from
 * the anchor WASM is interpolating from, and the excess is credited back so the two stay one
 * clock. The pure-arithmetic block at the end pins the ceiling helper against the Rust it
 * mirrors (u32 wrapping subtract, truncating divide).
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { HypercallDataManager, interpolatedClockCeilingUs } from "../../src/worker/core/cpu/hypercall-data";
import { TimeService } from "../../src/worker/runtime/time";

// Mirrors hypercall.rs (and hypercall-data.ts, where they are module-private).
const OFF_HC_PERF_COUNTER_LO = 0x014;
const OFF_HC_PERF_COUNTER_HI = 0x018;
const OFF_HC_INSN_AT_TIME_UPDATE = 0x02C;
const OFF_HC_MIPS_ESTIMATE = 0x030;

const HP_BASE = 0x1000;
const PAGE_BYTES = 0x20000;

type FakeCpu = { wasm_memory: { buffer: ArrayBuffer }; instruction_counter: Uint32Array };

function makeCpu(): FakeCpu {
    return { wasm_memory: { buffer: new ArrayBuffer(PAGE_BYTES) }, instruction_counter: new Uint32Array(1) };
}

function pageView(cpu: FakeCpu): DataView {
    return new DataView(cpu.wasm_memory.buffer);
}

/** The clock base the page currently carries, in µs. */
function publishedUs(cpu: FakeCpu): number {
    const v = pageView(cpu);
    return v.getUint32(HP_BASE + OFF_HC_PERF_COUNTER_HI, true) * 0x1_0000_0000
        + v.getUint32(HP_BASE + OFF_HC_PERF_COUNTER_LO, true);
}

/** What a guest reading the clock RIGHT NOW gets from WASM, from the page alone. */
function servedUs(cpu: FakeCpu): number {
    const v = pageView(cpu);
    return interpolatedClockCeilingUs(
        publishedUs(cpu),
        v.getUint32(HP_BASE + OFF_HC_INSN_AT_TIME_UPDATE, true),
        cpu.instruction_counter[0]!,
        v.getUint32(HP_BASE + OFF_HC_MIPS_ESTIMATE, true),
    );
}

/** A WASM `memory.grow`: a new buffer, contents preserved, instruction counter untouched. */
function growMemory(cpu: FakeCpu): void {
    const grown = new ArrayBuffer(cpu.wasm_memory.buffer.byteLength * 2);
    new Uint8Array(grown).set(new Uint8Array(cpu.wasm_memory.buffer));
    cpu.wasm_memory.buffer = grown;
}

/** A v86.restart(): HYPERCALL_PAGE is a Rust static, so the new buffer comes back zeroed. */
function restartMemory(cpu: FakeCpu): void {
    cpu.wasm_memory.buffer = new ArrayBuffer(PAGE_BYTES);
    cpu.instruction_counter[0] = 0;
}

let ts: TimeService;

function freshTime(): TimeService {
    const svc = TimeService.getInstance();
    svc.resetForGameSwitch();
    svc.enableVirtualTime();
    return svc;
}

describe("publishClock keeps the guest clock monotonic", () => {
    let mgr: HypercallDataManager;
    let cpu: FakeCpu;

    beforeEach(() => {
        ts = freshTime();
        cpu = makeCpu();
        mgr = new HypercallDataManager();
        mgr.initialize(cpu, HP_BASE);
        mgr.refreshTimeAfterThunk(cpu); // first publish — anchors the interpolation
    });

    it("never installs a base below what the interpolation has already served", () => {
        // The guest out-runs the assumed slope: 5M instructions retired while the JS clock
        // moved 1 ms. WASM has been handing out the interpolated value all along.
        cpu.instruction_counter[0] = 5_000_000;
        const alreadyServed = servedUs(cpu);
        ts.advanceVirtualTime(1);

        mgr.refreshTimeAfterThunk(cpu);

        expect(publishedUs(cpu)).toBeGreaterThanOrEqual(alreadyServed);
        const stats = mgr.getClockMonotonicStats();
        expect(stats.fixups).toBe(1);
        expect(stats.maxSuppressedUs).toBeGreaterThan(0);
    });

    it("credits the suppressed excess into TimeService so the two stay ONE clock", () => {
        cpu.instruction_counter[0] = 5_000_000;
        const alreadyServed = servedUs(cpu);
        ts.advanceVirtualTime(1);

        mgr.refreshTimeAfterThunk(cpu);

        // Without the credit-back, TimeService stays behind the page and the NEXT publish
        // recomputes the same regression.
        expect(ts.nowMs() * 1000).toBeGreaterThanOrEqual(alreadyServed - 1000);
        mgr.refreshTimeAfterThunk(cpu);
        expect(mgr.getClockMonotonicStats().fixups).toBe(1);
    });

    it("keeps the floor across a WASM memory growth", () => {
        // memory.grow invalidates the JS DataView and nothing else: the page still carries the
        // anchor, and the Rust side keeps serving from it. Dropping the anchor here would let
        // the next publish install a value below one the guest has already read.
        cpu.instruction_counter[0] = 5_000_000;
        const alreadyServed = servedUs(cpu);
        growMemory(cpu);
        ts.advanceVirtualTime(1);

        mgr.refreshTimeAfterThunk(cpu);

        expect(publishedUs(cpu)).toBeGreaterThanOrEqual(alreadyServed);
        expect(mgr.getClockMonotonicStats().fixups).toBe(1);
    });

    it("drops the anchor when the page was zeroed by a restart", () => {
        cpu.instruction_counter[0] = 5_000_000;
        restartMemory(cpu);
        const wantUs = Math.floor(ts.nowMs() * 1000);

        mgr.refreshTimeAfterThunk(cpu);

        // A dead anchor must not manufacture a ceiling out of a counter that restarted.
        expect(publishedUs(cpu)).toBe(wantUs);
        expect(mgr.getClockMonotonicStats().fixups).toBe(0);
    });
});

describe("publishClock's slope estimator", () => {
    let mgr: HypercallDataManager;
    let cpu: FakeCpu;

    beforeEach(() => {
        ts = freshTime();
        cpu = makeCpu();
        mgr = new HypercallDataManager();
        mgr.initialize(cpu, HP_BASE);
        mgr.refreshTimeAfterThunk(cpu);
    });

    /** Run `ticks` publishes at a steady `insnPerUs`, 1 ms of clock per publish. */
    function runAtRate(insnPerUs: number, ticks: number): void {
        let insn = cpu.instruction_counter[0]!;
        for (let i = 0; i < ticks; i++) {
            insn = (insn + insnPerUs * 1000) >>> 0;
            cpu.instruction_counter[0] = insn;
            ts.advanceVirtualTime(1);
            mgr.refreshTimeAfterThunk(cpu);
        }
    }

    it("tracks a host faster than the clock's own target rate, and stops correcting", () => {
        runAtRate(2000, 10);
        const settled = mgr.getClockMonotonicStats();
        expect(settled.mipsEstimate).toBeGreaterThan(1500);
        expect(settled.mipsPinned).toBe(false);

        // The real regression: a ceiling the host can reach pins the slope, every publish
        // then under-interpolates, and the floor becomes the clock's only advance path —
        // silently, forever. Once the estimate has converged, fixups must STOP.
        const fixupsBefore = settled.fixups;
        runAtRate(2000, 10);
        expect(mgr.getClockMonotonicStats().fixups).toBe(fixupsBefore);
    });

    it("reports the pinned condition instead of hiding it", () => {
        runAtRate(500_000, 10); // beyond any plausible host — the wrap guard must bite
        const stats = mgr.getClockMonotonicStats();
        expect(stats.mipsPinned).toBe(true);
        expect(stats.mipsCeilingHits).toBeGreaterThan(0);
        expect(stats.mipsEstimate).toBe(stats.mipsCeiling);
    });

    it("keeps the published slope clear of the u32 multiply in handle_get_tick_count", () => {
        runAtRate(500_000, 10);
        const mips = pageView(cpu).getUint32(HP_BASE + OFF_HC_MIPS_ESTIMATE, true);
        // Rust computes `delta_insn / (mips_est * 1000)` in u32: the divisor must not wrap.
        expect(mips).toBeGreaterThan(0);
        expect(mips * 1000).toBeLessThan(0x1_0000_0000);
    });
});

describe("TimeService serves one non-decreasing clock", () => {
    beforeEach(() => { ts = freshTime(); });

    it("nowMs never returns below a value it has already returned", () => {
        ts.advanceVirtualTime(10);
        const served = ts.nowMs();
        ts.advanceVirtualTime(-3); // any path that pulls the clock back
        expect(ts.nowMs()).toBe(served);
    });

    it("reanchoring to wall clock cannot un-serve a value the guest has read", () => {
        ts.advanceVirtualTime(50); // virtual leads wall, as it does in steady state
        const served = ts.nowMs();
        ts.reanchorToWallClock();
        expect(ts.nowMs()).toBeGreaterThanOrEqual(served);
        ts.notifyPauseResume();
        expect(ts.nowMs()).toBeGreaterThanOrEqual(served);
    });

    it("keeps the unsigned DWORD delta small across a reanchor", () => {
        ts.advanceVirtualTime(50);
        const before = ts.nowMs() | 0;
        ts.reanchorToWallClock();
        const after = ts.nowMs() | 0;
        // How a guest actually computes elapsed ms. A backwards step reads as ~2^32.
        expect((after - before) >>> 0).toBeLessThan(1000);
    });
});

describe("interpolatedClockCeilingUs mirrors the Rust arithmetic", () => {
    // Models handle_qpc / virtual_time_us: `base + delta_insn / mips` in µs.
    // handle_get_tick_count divides by `mips * 1000` instead, in MILLISECONDS, and nothing
    // on the TS side models that second divide — the floor is enforced on the µs base both
    // clocks are derived from, so a monotonic µs base makes its truncated ms monotonic too.
    it("adds the interpolation WASM has been serving since the publish", () => {
        // 300 insn at 3 insn/µs = 100 µs already handed out on top of the base.
        expect(interpolatedClockCeilingUs(1_000_000, 500, 800, 3)).toBe(1_000_100);
    });

    it("truncates the divide, like the integer WASM path", () => {
        expect(interpolatedClockCeilingUs(0, 0, 5, 3)).toBe(1);
    });

    it("follows the instruction counter across its 32-bit wrap", () => {
        // The counter is a u32; the delta must wrap, not go hugely negative.
        const before = 0xFFFF_FF00;
        const after = 0x0000_0064; // +356
        expect(interpolatedClockCeilingUs(7, before, after, 2)).toBe(7 + 178);
    });

    it("is the identity when the interpolation is disabled", () => {
        expect(interpolatedClockCeilingUs(1234, 0, 999_999, 0)).toBe(1234);
    });
});
