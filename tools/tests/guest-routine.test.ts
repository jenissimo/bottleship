import {afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test";
import {System} from "../../src/worker/core/system";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {CallbackManager} from "../../src/worker/core/thunking/callback-manager";
import {Process} from "../../src/worker/core/process";
import {runGuestRoutine, type GuestRoutine} from "../../src/worker/core/thunking/guest-routine";
import type {X86Context} from "../../src/worker/core/thunking/thunk-dispatcher";

const system = System.getInstance();
const saved = {process: system.process, scheduler: system.scheduler, isExiting: system.isExiting};
let mem: Uint8Array, cpu: any, manager: CallbackManager, process: any, owner: number;
const ENTRY = 0xc000, RETURN = 0x1000, TARGET = 0x1200, E_FAIL = 0x80004005;
const ctx = (esp = ENTRY): X86Context => ({esp} as X86Context);
let denyStack = false;

beforeEach(() => {
    mem = new Uint8Array(0x10000);
    Mem.bind(() => mem);
    cpu = {reg32: new Int32Array(8), instruction_pointer: new Int32Array(1), is_jumping: false};
    cpu.reg32[4] = ENTRY;
    new DataView(mem.buffer).setUint32(ENTRY, RETURN, true);
    owner = 1;
    denyStack = false;
    system.scheduler = {
        getCurrentThreadId: () => owner,
        getThreadStackBounds: () => ({base: 0xa000, top: 0xd000}),
    } as any;
    manager = new CallbackManager({cpu}, {} as any, () => mem);
    process = {resetGeneration: 0, dispatcher: {callbackManager: manager}, addressSpace: {
        validateRange: (p: number, n: number, perms: string) => p > 0 && p + n <= mem.length
            && !(denyStack && p >= 0xa000) && (!perms.includes("x") || (p >= RETURN && p < 0x2000)),
    }};
    system.process = process;
    system.isExiting = false;
    manager.initialize({getRegions: () => ({callbackStubPoolBase: 0x4000, callbackStubPoolSize: 0x4000})} as any);
});
afterEach(() => {
    manager.reset();
    system.process = saved.process;
    system.scheduler = saved.scheduler;
    system.isExiting = saved.isExiting;
});

function finish(id: number, value: number): void {
    const call = manager.getPendingCallback(id)!;
    // A real stdcall RET has popped its args; the return stub's PUSH EAX is observed here.
    cpu.reg32[4] = call.espBeforeInvoke! - 4;
    new DataView(mem.buffer).setUint32(cpu.reg32[4], value, true);
    manager.handleCallbackReturn(id);
}

describe("guest routines over the real callback manager", () => {
    test("dependent calls reacquire the view after WASM-like growth", () => {
        const r = runGuestRoutine(ctx(), mem, (function* (): GuestRoutine {
            yield {fn: TARGET, args: [], tag: "grow"};
            return yield {fn: 0x18000, args: [], tag: "new memory"};
        })(), 0, "growth") as any;
        const old = mem; mem = new Uint8Array(0x20000); mem.set(old);
        structuredClone(old.buffer, {transfer: [old.buffer]});
        process.addressSpace.validateRange = (p: number, n: number) => p > 0 && p + n <= mem.length;
        finish(r.callbackId, 1);
        const nextId = [...(manager as any).pendingCallbacks.keys()][0] as number;
        expect(manager.getPendingCallback(nextId)!.callbackAddress).toBe(0x18000);
        finish(nextId, 42);
        expect(cpu.reg32[0]).toBe(42);
        expect(manager.getPendingCount()).toBe(0);
    });

    test("a rejected callback frame returns its stub slot to the pool", () => {
        expect(() => manager.invokeCallback(TARGET, new Array(0x4000).fill(0))).toThrow();
        const stubs = [...(manager as any).stubsById.values()] as Array<{inUse: boolean}>;
        expect(stubs.filter(s => s.inUse)).toHaveLength(0);
        expect(manager.getPendingCount()).toBe(0);
    });

    test("Process.reset cancels suspended generators before recycling heap addresses", async () => {
        let closed = 0;
        runGuestRoutine(ctx(), mem, (function* (): GuestRoutine {
            try { yield {fn: TARGET, args: [], tag: "pending reset"}; }
            finally { closed++; }
            return 0;
        })(), 0, "process reset");
        const marker = new Error("heap reached");
        const model = {resetGeneration: 0, resetListeners: new Set<() => void>(),
            getMemory: () => mem, dispatcher: {callbackManager: manager},
            addressSpace: {getRegions: () => [], reset: () => {}}, initializeMemoryLayout: () => {},
            memory: {reset: () => {
                expect(closed).toBe(1);
                expect(manager.getPendingCount()).toBe(0);
                throw marker;
            }},
        };
        await expect(Process.prototype.reset.call(model as any)).rejects.toThrow("heap reached");
    });
    test("a long dependent call chain keeps one stack anchor and restores RET N exactly", () => {
        let result = runGuestRoutine(ctx(), mem, (function* (): GuestRoutine {
            let value = 0;
            for (let i = 0; i < 200; i++) value = yield {fn: TARGET, args: [i], tag: "stream"};
            return value;
        })(), 8, "load");
        expect(typeof result).toBe("object");
        for (let i = 0; i < 200; i++) {
            const id = [...(manager as any).pendingCallbacks.keys()][0] as number;
            expect(manager.getPendingCallback(id)!.espBeforeInvoke).toBe(ENTRY);
            expect(cpu.reg32[4]).toBe(ENTRY - 8);
            finish(id, i + 1);
        }
        expect(cpu.reg32[0]).toBe(200);
        expect(cpu.reg32[4]).toBe(ENTRY + 12);
        expect(cpu.instruction_pointer[0]).toBe(RETURN);
        expect(manager.getPendingCount()).toBe(0);
    });

    test("a nested routine completes independently of the outer guest call", () => {
        const outer = runGuestRoutine(ctx(), mem, (function* (): GuestRoutine {
            return (yield {fn: TARGET, args: [1], tag: "outer"}) + 1;
        })(), 8, "outer") as any;
        const nestedEsp = ENTRY - 64;
        new DataView(mem.buffer).setUint32(nestedEsp, TARGET + 4, true);
        cpu.reg32[4] = nestedEsp;
        const inner = runGuestRoutine(ctx(nestedEsp), mem, (function* (): GuestRoutine {
            return (yield {fn: TARGET + 8, args: [], tag: "inner"}) + 10;
        })(), 4, "inner") as any;
        finish(inner.callbackId, 3);
        expect(cpu.reg32[0]).toBe(13);
        expect(cpu.reg32[4]).toBe(nestedEsp + 8);
        expect(manager.getPendingCount()).toBe(1);
        finish(outer.callbackId, 7);
        expect(cpu.reg32[0]).toBe(8);
        expect(cpu.reg32[4]).toBe(ENTRY + 12);
        expect(manager.getPendingCount()).toBe(0);
    });

    test("rejects unreadable/truncated entry stacks before starting the generator", () => {
        let entered = false;
        const routine = () => (function* (): GuestRoutine { entered = true; return 0; })();
        denyStack = true;
        expect(runGuestRoutine(ctx(), mem, routine(), 8, "guard")).toBe(E_FAIL);
        denyStack = false;
        expect(runGuestRoutine(ctx(mem.length - 2), mem, routine(), 8, "guard")).toBe(E_FAIL);
        expect(runGuestRoutine(ctx(), mem, routine(), 0xfffffff0, "guard")).toBe(E_FAIL);
        expect(entered).toBe(false);
    });

    test("refused and thrown dispatch failures reach the generator without leaking a callback", () => {
        const fail = spyOn(manager, "invokeCallback").mockImplementationOnce(() => { throw new Error("no slot"); })
            .mockImplementationOnce(() => ({callbackId: 0}));
        try {
            const value = runGuestRoutine(ctx(), mem, (function* (): GuestRoutine {
                expect(yield {fn: TARGET, args: [], tag: "throw"}).toBe(E_FAIL);
                expect(yield {fn: TARGET, args: [], tag: "refuse"}).toBe(E_FAIL);
                expect(yield {fn: 0, args: [], tag: "null"}).toBe(E_FAIL);
                return 17;
            })(), 0, "failure");
            expect(value).toBe(17);
            expect(manager.getPendingCount()).toBe(0);
        } finally { fail.mockRestore(); }
    });

    test("reset closes JS finally blocks without dispatching cleanup into the guest", () => {
        let closed = 0, dispatched = 0;
        runGuestRoutine(ctx(), mem, (function* (): GuestRoutine {
            try { yield {fn: TARGET, args: [], tag: "pending"}; }
            finally { yield {fn: TARGET, args: [], tag: "release"}; closed++; }
            dispatched++;
            return 0;
        })(), 0, "reset");
        manager.reset();
        expect(closed).toBe(1);
        expect(dispatched).toBe(0);
        expect(manager.getPendingCount()).toBe(0);
    });

    test("a stale in-place process generation cannot resume the old return context", () => {
        let closed = 0;
        const r = runGuestRoutine(ctx(), mem, (function* (): GuestRoutine {
            try { yield {fn: TARGET, args: [], tag: "old"}; return 1; }
            finally { closed++; }
        })(), 8, "epoch") as any;
        process.resetGeneration++;
        cpu.instruction_pointer[0] = 0x1800;
        finish(r.callbackId, 9);
        expect(cpu.instruction_pointer[0]).toBe(0x1800);
        expect(cpu.reg32[4]).toBe(ENTRY - 4);
        expect(closed).toBe(1);
        expect(manager.getPendingCount()).toBe(0);
    });

    test("a return on another thread cancels the routine before writing that thread's registers", () => {
        let closed = 0;
        const r = runGuestRoutine(ctx(), mem, (function* (): GuestRoutine {
            try { yield {fn: TARGET, args: [], tag: "owner"}; return 1; }
            finally { closed++; }
        })(), 8, "thread") as any;
        const fatal = spyOn(manager as any, "reportFatalFromCallback").mockImplementation(() => {});
        try {
            owner = 2;
            cpu.instruction_pointer[0] = 0x1900;
            finish(r.callbackId, 3);
            expect(cpu.instruction_pointer[0]).toBe(0x1900);
            expect(cpu.reg32[4]).toBe(ENTRY - 4);
            expect(fatal).toHaveBeenCalledTimes(1);
            expect(closed).toBe(1);
            expect(manager.getPendingCount()).toBe(0);
        } finally { fatal.mockRestore(); }
    });
});
