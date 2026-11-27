import { describe, expect, it } from "bun:test";
import {
    CPU_VIEW_OFFSETS, cpuViews, cpuViewsForBuffer, readEip, readEsp, readRetiredInsns,
    resetCpuViews, resetWasmGrowthStats, getWasmGrowthStats, noteWasmBuffer,
    PROXY_BASELINE, syncProxyBaselineFlag,
} from "../../src/worker/core/cpu/cpu-views";


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
