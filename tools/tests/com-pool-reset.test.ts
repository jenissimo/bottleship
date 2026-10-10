import { afterEach, describe, expect, test } from "bun:test";
import { MemoryManager } from "../../src/worker/core/process";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import {
    allocateComObject, freeComObject, registerComVtableOwner, resetComMemory,
} from "../../src/worker/core/com/com-memory";

afterEach(() => resetComMemory());

describe("COM pools across an in-place allocator reset", () => {
    test("new live objects never alias a block pooled by the previous game", () => {
        const mem = new Uint8Array(8 * 1024 * 1024);
        const space = new AddressSpace(() => mem);
        space.registerRegion({ base: 0x100000, size: 6 * 1024 * 1024, kind: "HEAP", perms: "rw", owner: "Layout" });
        const manager = new MemoryManager(space);
        manager.refreshLayoutBuckets();
        Mem.bind(() => mem, (addr, size, perms) => space.validateRange(addr, size, perms));
        registerComVtableOwner(0x100, "pool-reset-a");
        registerComVtableOwner(0x200, "pool-reset-b");

        const old = allocateComObject(manager, mem, 0x100);
        freeComObject(manager, old);
        const recycled = allocateComObject(manager, mem, 0x100);
        expect(recycled).toBe(old);
        freeComObject(manager, recycled);

        manager.reset();
        const b = allocateComObject(manager, mem, 0x200);
        const a = allocateComObject(manager, mem, 0x100);
        expect(a).not.toBe(b);
        expect(Mem.readUint32(b)).toBe(0x200);
        expect(Mem.readUint32(a)).toBe(0x100);
    });
});
