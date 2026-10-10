import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMinidump, formatCrash } from "../cdp-crashes";

function dump(code: number, parameters: bigint[]) {
    const dir = mkdtempSync(join(tmpdir(), "bottleship-crash-test-"));
    const path = join(dir, "fixture.dmp");
    const bytes = Buffer.alloc(240);
    bytes.write("MDMP");
    bytes.writeUInt32LE(1, 8);
    bytes.writeUInt32LE(32, 12);
    bytes.writeUInt32LE(6, 32);
    bytes.writeUInt32LE(168, 36);
    bytes.writeUInt32LE(64, 40);
    bytes.writeUInt32LE(code, 72);
    bytes.writeUInt32LE(parameters.length, 96);
    parameters.forEach((value, index) => bytes.writeBigUInt64LE(value, 104 + index * 8));
    writeFileSync(path, bytes);
    try { return parseMinidump(path)!; }
    finally { unlinkSync(path); rmdirSync(dir); }
}

test("Chrome OOM retains a 64-bit attempted allocation and commit telemetry", () => {
    const crash = dump(0xe0000008, [0x200000000n, 0x1200000000n, 0x800000000n]);
    expect(crash.oomAllocationBytes).toBe("8589934592");
    expect(crash.oomCommitLimitBytes).toBe("77309411328");
    expect(crash.oomAvailableCommitBytes).toBe("34359738368");
    expect(formatCrash(crash)).toContain("requested 8589934592 bytes");
});

test("missing OOM telemetry is unknown, and AV parameters keep their meaning", () => {
    const unknown = dump(0xe0000008, [0n, 0xffffffffffffffffn]);
    expect(unknown.oomAllocationBytes).toBeNull();
    expect(unknown.oomCommitLimitBytes).toBeNull();
    expect(unknown.oomAvailableCommitBytes).toBeNull();
    expect(dump(0xe0000008, [4096n, 0x1200000000n, 0n]).oomAvailableCommitBytes).toBe("0");
    const av = dump(0xc0000005, [1n, 0x12345678n]);
    expect(av.accessKind).toBe("write");
    expect(av.accessAddress).toBe(0x12345678n);
    expect(av.oomAllocationBytes).toBeNull();
});
