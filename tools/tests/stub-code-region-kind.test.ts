/**
 * Stub-DLL code is registered where it actually lives.
 *
 * MemoryManager.allocAt defaults to HEAP/rw, and the THUNK_CODE bucket begins exactly
 * where HEAP ends, so an unkinded allocAt for a thunk address cannot succeed — it is
 * outside the bucket by construction. A caller that also swallows the throw reserves
 * nothing at all: the bucket's own frontier never advances past the live stubs, and the
 * allocator can later hand the same range out on top of code the guest's IAT points at.
 */
import { expect, test } from "bun:test";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { MemoryManager } from "../../src/worker/core/process";
import { MEM_THUNK_CODE_BASE } from "../../src/worker/core/cpu/emulator-config";

const MEM_SIZE = 0x40000000; // 1 GB — enough for the fixed layout's THUNK_CODE bucket.

function makeManager(): MemoryManager {
    // initializeLayout clamps every bucket to the backing size, so the view must be
    // the real linear extent; the bytes themselves are never touched here.
    const mem = new Uint8Array(MEM_SIZE);
    const space = new AddressSpace(() => mem);
    space.initializeLayout(MEM_SIZE);
    const manager = new MemoryManager(space);
    manager.refreshLayoutBuckets();
    return manager;
}

const STUB_BASE = MEM_THUNK_CODE_BASE + 0x20000;

test("an unkinded allocAt cannot reserve stub code", () => {
    expect(() => makeManager().allocAt(STUB_BASE, 0x400)).toThrow(/bucket bounds/);
});

test("THUNK_CODE/rx reserves it and advances the bucket past the stubs", () => {
    const manager = makeManager();
    expect(manager.allocAt(STUB_BASE, 0x400, "THUNK_CODE", "rx")).toBe(STUB_BASE);
    // The next THUNK_CODE allocation must not overlap the stubs just reserved.
    expect(manager.alloc(0x100, "THUNK_CODE", "rx")).toBeGreaterThanOrEqual(STUB_BASE + 0x400);
});
