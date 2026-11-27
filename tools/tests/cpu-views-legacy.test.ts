import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CPU_VIEW_OFFSETS } from "../../src/worker/core/cpu/cpu-views";

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

function parseRustOffsets(): Map<string, number> {
    const src = readFileSync(GLOBAL_POINTERS, "utf8");
    const out = new Map<string, number>();
    const re = /pub const (\w+)\s*:\s*\*mut [^=]+=\s*(\d+)\s+as/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.set(m[1]!, Number(m[2]));
    return out;
}

const rust = parseRustOffsets();

describe("cpu-views offsets are pinned to vendor/v86 global_pointers.rs", () => {
    it("every offset matches the Rust it mirrors", () => {
        const missing: string[] = [];
        const wrong: string[] = [];
        for (const [ours, theirs] of Object.entries(RUST_NAME)) {
            const want = rust.get(theirs);
            if (want === undefined) { missing.push(`${ours} -> ${theirs}`); continue; }
            const got = CPU_VIEW_OFFSETS[ours as keyof typeof CPU_VIEW_OFFSETS];
            if (got !== want) wrong.push(`${ours} (${theirs}): ours ${got}, v86 ${want}`);
        }
        expect({ missing, wrong }).toEqual({ missing: [], wrong: [] });
    });

    it("the Rust constants this test claims to read really parsed", () => {
        // Guards the parse itself: a regex that silently matched nothing would make the
        // check above pass by having nothing to compare.
        expect(rust.get("reg32")).toBe(64);
        expect(rust.get("instruction_pointer")).toBe(556);
        expect(rust.size).toBeGreaterThan(30);
    });
});
