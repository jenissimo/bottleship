/**
 * `core/cpu/cpu-views.ts` is a second copy of v86's CPU-state layout.
 *
 * That is the whole point of the module — plain typed arrays built at fixed offsets instead
 * of v86's re-resolving `view()` Proxy — and it is also the module's only real hazard: a
 * layout bump in the Rust would leave us reading EIP where EBX is, silently, on every
 * context switch. The offsets are therefore PINNED AGAINST THEIR SOURCE here rather than
 * against a hand-copied constant, so the test cannot agree with a mistake it shares.
 *
 * vendor/v86 is a submodule; when it is absent these checks skip rather than pass (the
 * shape validate-jit-exports uses). A skip is visible in the runner output; a fake pass
 * would not be.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    CPU_VIEW_OFFSETS, cpuViews, cpuViewsForBuffer, readEip, readEsp, readRetiredInsns,
    resetCpuViews, resetWasmGrowthStats, getWasmGrowthStats, noteWasmBuffer,
    PROXY_BASELINE, syncProxyBaselineFlag,
} from "../../src/worker/core/cpu/cpu-views";

const GLOBAL_POINTERS = join(
    import.meta.dir, "..", "..", "vendor", "v86", "src", "rust", "cpu", "global_pointers.rs",
);

/** Our field name → the Rust constant it mirrors. */
const RUST_NAME: Record<keyof typeof CPU_VIEW_OFFSETS, string> = {
    reg32: "reg32",
    lastOpSize: "last_op_size",
    flagsChanged: "flags_changed",
    lastOp1: "last_op1",
    lastResult: "last_result",
    flags: "flags",
    instructionPointer: "instruction_pointer",
    previousIp: "previous_ip",
    cr: "cr",
    cpl: "cpl",
    fpuSimdDirty: "fpu_simd_dirty",
    prefixes: "prefixes",
    instructionCounter: "instruction_counter",
    sreg: "sreg",
    segmentIsNull: "segment_is_null",
    segmentOffsets: "segment_offsets",
    segmentLimits: "segment_limits",
    protectedMode: "protected_mode",
    is32: "is_32",
    memorySize: "memory_size",
    mxcsr: "mxcsr",
};

function parseRustOffsets(): Map<string, number> | null {
    if (!existsSync(GLOBAL_POINTERS)) return null;
    const src = readFileSync(GLOBAL_POINTERS, "utf8");
    const out = new Map<string, number>();
    const re = /pub const (\w+)\s*:\s*\*mut [^=]+=\s*(\d+)\s+as/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.set(m[1]!, Number(m[2]));
    return out.size > 0 ? out : null;
}

const rust = parseRustOffsets();

describe("cpu-views offsets are pinned to vendor/v86 global_pointers.rs", () => {
    it.skipIf(rust === null)("every offset matches the Rust it mirrors", () => {
        const missing: string[] = [];
        const wrong: string[] = [];
        for (const [ours, theirs] of Object.entries(RUST_NAME)) {
            const want = rust!.get(theirs);
            if (want === undefined) { missing.push(`${ours} -> ${theirs}`); continue; }
            const got = CPU_VIEW_OFFSETS[ours as keyof typeof CPU_VIEW_OFFSETS];
            if (got !== want) wrong.push(`${ours} (${theirs}): ours ${got}, v86 ${want}`);
        }
        expect({ missing, wrong }).toEqual({ missing: [], wrong: [] });
    });

    it.skipIf(rust === null)("the Rust constants this test claims to read really parsed", () => {
        // Guards the parse itself: a regex that silently matched nothing would make the
        // check above pass by having nothing to compare.
        expect(rust!.get("reg32")).toBe(64);
        expect(rust!.get("instruction_pointer")).toBe(556);
        expect(rust!.size).toBeGreaterThan(30);
    });
});

describe("cpu-views reads and writes the CPU state block", () => {
    function cpuWith(bytes = 4096) {
        resetCpuViews();
        return { wasm_memory: { buffer: new ArrayBuffer(bytes) } };
    }

    it("addresses the same bytes the offsets name", () => {
        const cpu = cpuWith();
        const raw = new DataView(cpu.wasm_memory.buffer);
        raw.setInt32(CPU_VIEW_OFFSETS.reg32 + 4 * 4, 0x0028_ff00, true); // ESP
        raw.setInt32(CPU_VIEW_OFFSETS.instructionPointer, 0x0040_1000, true);
        raw.setUint32(CPU_VIEW_OFFSETS.instructionCounter, 123_456, true);

        expect(readEsp(cpu)).toBe(0x0028_ff00);
        expect(readEip(cpu)).toBe(0x0040_1000);
        expect(readRetiredInsns(cpu)).toBe(123_456);

        cpuViews(cpu).segmentOffsets[4] = 0x7ffd_e000 | 0; // FS base
        expect(raw.getInt32(CPU_VIEW_OFFSETS.segmentOffsets + 16, true)).toBe(0x7ffd_e000 | 0);
    });

    it("rebuilds after the WASM buffer is replaced", () => {
        const cpu = cpuWith();
        const before = cpuViews(cpu);
        expect(cpuViews(cpu)).toBe(before); // stable while the buffer holds

        cpu.wasm_memory.buffer = new ArrayBuffer(8192);
        const after = cpuViews(cpu);
        expect(after).not.toBe(before);
        expect(after.buffer).toBe(cpu.wasm_memory.buffer);

        new DataView(cpu.wasm_memory.buffer).setInt32(CPU_VIEW_OFFSETS.instructionPointer, 0x1234, true);
        expect(readEip(cpu)).toBe(0x1234);
    });

    it("falls back to the CPU's own arrays when there is no WASM memory", () => {
        resetCpuViews();
        const reg32 = new Int32Array(8);
        reg32[4] = 0x0022_0000;
        const cpu = { reg32, instruction_pointer: Int32Array.of(0x99) };
        expect(readEsp(cpu)).toBe(0x0022_0000);
        expect(readEip(cpu)).toBe(0x99);
        expect(cpuViews(cpu).flat).toBe(false);
    });
});

describe("the WASM growth ledger", () => {
    it("counts buffer changes after the first, once per change", () => {
        resetCpuViews();
        resetWasmGrowthStats();
        const a = new ArrayBuffer(4096);
        const b = new ArrayBuffer(8192);

        cpuViewsForBuffer(a);
        expect(getWasmGrowthStats().growths).toBe(0); // the initial mapping is not a growth

        cpuViewsForBuffer(b);
        // A second observer of the SAME change must not double-count it — the dispatcher's
        // updateMemoryCache and this module both see one grow between them.
        expect(noteWasmBuffer(b, 0, "test")).toBe(false);
        const stats = getWasmGrowthStats();
        expect(stats.growths).toBe(1);
        expect(stats.bytes).toBe(8192);
        expect(stats.events[0]!.deltaBytes).toBe(4096);
    });
});

describe("the A/B baseline switch", () => {
    // The armed arm is supposed to reproduce the pre-conversion Proxy reads. If arming it
    // did nothing, a paired A/B would report a delta of zero and the reason would be the
    // switch, not the change — the exact failure this repo keeps rediscovering.
    it("follows the worker flag in both directions", () => {
        const g = globalThis as Record<string, unknown>;
        const prev = g["__v86ProxyBaseline"];
        try {
            g["__v86ProxyBaseline"] = true;
            expect(syncProxyBaselineFlag()).toBe(true);
            expect(PROXY_BASELINE.on).toBe(true);

            delete g["__v86ProxyBaseline"];
            expect(syncProxyBaselineFlag()).toBe(false);
            expect(PROXY_BASELINE.on).toBe(false);

            // Only `true` arms it — a stray truthy string must not silently switch arms.
            g["__v86ProxyBaseline"] = "yes";
            expect(syncProxyBaselineFlag()).toBe(false);
        } finally {
            if (prev === undefined) delete g["__v86ProxyBaseline"];
            else g["__v86ProxyBaseline"] = prev;
            syncProxyBaselineFlag();
        }
    });
});
