/**
 * Re-installing a COM vtable must succeed.
 *
 * `generateStubDll` serves a method that already has a stub out of its reuse cache without
 * emitting a byte, so the SECOND install of an interface produces a complete export table
 * and an empty code batch. `installComVtable` used to read that emptiness as failure and
 * return null — and its callers respond to null by leaving the vtable alone. The released-COM
 * trap re-installs precisely when the recorded slots no longer hold stubs, so the refusal
 * left a zeroed vtable in place and the guest's next dispatch through it was `call 0`.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { installComVtable, type ComVtableMethod } from "../../src/worker/core/com/install-com-vtable";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

let memory: Uint8Array;
let proc: any;
let nextAlloc: number;

const METHODS: ComVtableMethod[] = [0, 1, 2].map((i) => ({ name: `Slot${i}`, argCount: 1, stackCleanupBytes: 0 }));
const HANDLERS = Object.fromEntries(METHODS.map((m) => [m.name, () => 0]));

beforeEach(() => {
    memory = new Uint8Array(0x200000);
    nextAlloc = 0x100000;
    const thunkGenerator = new ThunkGenerator();
    thunkGenerator.setBaseAddress(0x1000);
    proc = {
        memory: {
            alloc: (size: number) => { const p = nextAlloc; nextAlloc += Math.max(4, size); return p; },
            allocAt: () => undefined,
        },
        dispatcher: { registerModule: () => undefined, applyPendingRegistrations: () => undefined },
        thunkGenerator,
        getCurrentMemory: () => memory,
    };
    Mem.bind(() => memory, (a, s) => a >= 0 && a + s <= memory.length);
});

const install = () => installComVtable(proc, { moduleName: "test.trap", methods: METHODS, handlers: HANDLERS as any });

describe("installComVtable — re-install", () => {
    test("the second batch emits no code but resolves every export", () => {
        install();
        const again = proc.thunkGenerator.generateStubDll("test.trap",
            METHODS.map((m) => ({ name: m.name, argCount: m.argCount, stackCleanupBytes: 0, callingConvention: "stdcall" })));
        // This is the shape the bug hinged on: nothing emitted, everything resolved.
        expect(again.stubCode.length).toBe(0);
        expect(again.exportTable.size).toBe(METHODS.length);
    });

    test("re-installing succeeds and points at the same stubs", () => {
        const first = install();
        expect(first).not.toBeNull();
        const second = install();
        expect(second).not.toBeNull();
        for (let i = 0; i < METHODS.length; i++) {
            expect(Mem.readUint32(second!.vtableAddr + i * 4)).toBe(Mem.readUint32(first!.vtableAddr + i * 4));
        }
    });

    test("a vtable whose slots were zeroed is restored by the re-install", () => {
        const first = install();
        // What the release path does: poison the slots, then ask for the trap again.
        for (let i = 0; i < METHODS.length; i++) Mem.writeUint32(first!.vtableAddr + i * 4, 0);
        const second = install();
        expect(second).not.toBeNull();
        for (let i = 0; i < METHODS.length; i++) {
            expect(Mem.readUint32(second!.vtableAddr + i * 4)).toBeGreaterThan(0);
        }
    });
});
