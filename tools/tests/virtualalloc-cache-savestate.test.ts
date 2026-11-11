import { afterEach, beforeEach, expect, test } from "bun:test";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { MemoryManager } from "../../src/worker/core/process";
import { ModuleRegistry } from "../../src/worker/core/module-registry";
import { System } from "../../src/worker/core/system";
import {
    exports as api, resetHeapSlab, captureKernel32Memory, restoreKernel32Memory,
} from "../../src/worker/modules/kernel32/memory";
import { MEM_HEAP_BASE } from "../../src/worker/core/cpu/emulator-config";

// A block VirtualFree parks for recycling is FREE to the guest but still allocated in
// MemoryManager. The snapshot carries MemoryManager's view, so it must carry the parking
// too: otherwise the restored block can neither be recycled nor claimed by address, and a
// cache the restoring process had already filled names blocks of a state that is gone.

const MB = 0x100000, BLOCK = 0x10000, RW = 4;
const COMMIT = 0x1000, RESERVE = 0x2000, RELEASE = 0x8000, FREE = 0x10000;
const QUERY = 0x10100;

const system = System.getInstance() as any;
let savedProcess: unknown, savedScheduler: unknown;
let mem: Uint8Array, view: DataView, space: AddressSpace, memory: MemoryManager, lastError = 0;

const call = (name: string, args: number[]) => (api[name] as any)({} as any, mem, args) as number;
const alloc = (size: number, address = 0) => call("VirtualAlloc", [address, size, RESERVE | COMMIT, RW]) >>> 0;
const state = (address: number) => {
    expect(call("VirtualQuery", [address, QUERY, 28])).toBe(28);
    return view.getUint32(QUERY + 16, true);
};

/** A fresh process over the same guest RAM: what a reset before restore leaves. */
function newProcess(): void {
    space = new AddressSpace(() => mem); space.initializeLayout(mem.length);
    memory = new MemoryManager(space); memory.refreshLayoutBuckets();
    system.process = { addressSpace: space, memory, moduleRegistry: new ModuleRegistry(), getCurrentMemory: () => mem };
}

beforeEach(() => {
    savedProcess = system.process; savedScheduler = system.scheduler;
    resetHeapSlab(); (globalThis as any).vaCacheEnable(true);
    mem = new Uint8Array(MEM_HEAP_BASE + 16 * MB); view = new DataView(mem.buffer);
    system.scheduler = { setLastError: (e: number) => { lastError = e; }, findStackReservation: () => null };
    lastError = 0;
    newProcess();
});
afterEach(() => {
    resetHeapSlab();
    system.process = savedProcess; system.scheduler = savedScheduler;
});

test("a parked block survives capture -> reset -> restore: claimable by address, and the stale cache is gone", () => {
    const parked = alloc(BLOCK);
    const live = alloc(BLOCK);
    expect(call("VirtualFree", [parked, 0, RELEASE])).toBe(1);
    expect((globalThis as any).vaCacheReport().parkedBytes).toBe(BLOCK);
    const snap = { space: space.captureState(), memory: memory.captureState(), k32: captureKernel32Memory() };

    // The restoring process has parked a block of its own — at the address that is LIVE
    // in the snapshot.
    resetHeapSlab();
    newProcess();
    expect(alloc(BLOCK)).toBe(parked);
    expect(alloc(BLOCK)).toBe(live);
    expect(call("VirtualFree", [live, 0, RELEASE])).toBe(1);

    space.restoreState(snap.space);
    memory.restoreState(snap.memory);
    restoreKernel32Memory(snap.k32);

    expect((globalThis as any).vaCacheReport().parkedBytes).toBe(BLOCK);
    expect(state(parked)).toBe(FREE);
    expect(memory.getSize(parked)).toBe(BLOCK);
    expect(state(live)).toBe(COMMIT);

    // A fixed-address claim over the parked block succeeds and VirtualQuery agrees.
    expect(alloc(BLOCK, parked)).toBe(parked);
    expect(lastError).toBe(0);
    expect(state(parked)).toBe(COMMIT);
    expect(memory.getSize(parked)).toBe(BLOCK);
    expect((globalThis as any).vaCacheReport().parkedBytes).toBe(0);

    // Nothing hands out the snapshot's live block.
    view.setUint32(live, 0x5348, true);
    const next = alloc(BLOCK);
    expect(next).not.toBe(0);
    expect(next).not.toBe(live);
    expect(view.getUint32(live, true)).toBe(0x5348);
});

test("after a restore the parked block is what an anonymous VirtualAlloc recycles", () => {
    const parked = alloc(BLOCK);
    expect(call("VirtualFree", [parked, 0, RELEASE])).toBe(1);
    const snap = { space: space.captureState(), memory: memory.captureState(), k32: captureKernel32Memory() };

    resetHeapSlab();
    newProcess();
    space.restoreState(snap.space);
    memory.restoreState(snap.memory);
    restoreKernel32Memory(snap.k32);

    const hitsBefore = (globalThis as any).vaCacheReport().hits;
    expect(alloc(BLOCK)).toBe(parked);
    expect((globalThis as any).vaCacheReport().hits).toBe(hitsBefore + 1);
    expect(state(parked)).toBe(COMMIT);
});
