/**
 * Fibers switch the callee-saved registers, ESP and the TEB's stack/SEH fields on one
 * thread. SwitchToFiber leaves ESP at a slot whose return address the thunk stub's RET 4
 * pops — the setjmp/longjmp contract — so a fiber that has not run yet must have its start
 * routine there, with the thread-exit stub and the parameter laid out behind it.
 * GetCurrentFiber/GetFiberData are inline fs:[0x10] reads, so TEB.FiberData must point at
 * an object whose first dword is the parameter.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { exports as fiber, resetFiberState } from "../../src/worker/modules/kernel32/fiber";

const system = System.getInstance() as any;
const saved = { process: system.process, scheduler: system.scheduler };
const TEB = 0x3000, EXIT_STUB = 0x7777;
let mem: Uint8Array, dv: DataView, cpu: any, lastError = 0, imageReserve = 0, freed: number[] = [];

beforeEach(() => {
    mem = new Uint8Array(8 << 20);
    dv = new DataView(mem.buffer);
    Mem.bind(() => mem);
    let next = 0x100000;
    cpu = { reg32: new Int32Array(8), instruction_pointer: new Int32Array(1), segment_offsets: new Int32Array([0, 0, 0, 0, TEB, 0]) };
    system.process = {
        v86: { cpu },
        resetGeneration: 0,
        memory: {
            alloc: (n: number, _k?: unknown, _p?: unknown, align = 8) => { next = (next + align - 1) & ~(align - 1); const p = next; next += n; return p; },
            free: (p: number) => { freed.push(p); },
        },
    };
    imageReserve = 0; freed = []; lastError = 0;
    system.scheduler = {
        setLastError: (e: number) => { lastError = e; }, getThreadExitStubAddress: () => EXIT_STUB, getImageStackReserve: () => imageReserve,
        allocateStack: (n: number) => system.process.memory.alloc(n, undefined, undefined, 0x1000),
        releaseStackBlock: (p: number) => { freed.push(p); return true; },
    };
    resetFiberState();
    dv.setUint32(TEB + 0, 0x5000, true);      // ExceptionList
    dv.setUint32(TEB + 4, 0x40000, true);     // StackBase
    dv.setUint32(TEB + 8, 0x20000, true);     // StackLimit
});
afterEach(() => { system.process = saved.process; system.scheduler = saved.scheduler; resetFiberState(); });

const call = (name: string, ...args: number[]) => (fiber[name] as any)({}, mem, args);
const u32 = (a: number) => dv.getUint32(a, true);

test("a thread becomes a fiber whose object carries its parameter", () => {
    const main = call("ConvertThreadToFiber", 0xABCD);
    expect(main).toBeGreaterThan(0);
    expect(u32(TEB + 0x10)).toBe(main);
    expect(u32(main)).toBe(0xABCD);
    expect(call("ConvertThreadToFiber", 1)).toBe(0);
    expect(lastError).toBe(1280);
});

test("switching into a new fiber lands on its start routine with the parameter behind the exit stub", () => {
    const main = call("ConvertThreadToFiber", 0);
    const f = call("CreateFiber", 0, 0x401000, 0x1234);
    expect(u32(f)).toBe(0x1234);

    // Caller state at the SwitchToFiber thunk: [esp] = return address, [esp+4] = argument.
    const callerEsp = 0x3FF00;
    dv.setUint32(callerEsp, 0x402222, true);
    dv.setUint32(callerEsp + 4, f, true);
    cpu.reg32.set([0, 0, 0, 0xB1, callerEsp, 0xB5, 0xB6, 0xB7]);

    const r = call("SwitchToFiber", f);
    expect(r.skipStackCheck).toBe(true);
    expect(u32(TEB + 0x10)).toBe(f);
    expect(u32(TEB + 0)).toBe(0xFFFFFFFF);
    const esp = cpu.reg32[4] >>> 0;
    expect(u32(TEB + 4)).toBeGreaterThan(esp);
    expect(u32(TEB + 8)).toBeLessThan(esp);
    // EIP is a guest RET 4, which pops the start routine and the argument slot.
    expect(mem[cpu.instruction_pointer[0] >>> 0]).toBe(0xC2);
    expect(mem[(cpu.instruction_pointer[0] >>> 0) + 1]).toBe(4);
    const eip = u32(esp);
    const afterRet = esp + 8;
    expect(eip).toBe(0x401000);
    expect(u32(afterRet)).toBe(EXIT_STUB);
    expect(u32(afterRet + 4)).toBe(0x1234);

    // Back to the thread fiber: registers, ESP and TEB fields come back as they were.
    cpu.reg32[3] = 0; cpu.reg32[5] = 0; cpu.reg32[6] = 0; cpu.reg32[7] = 0;
    cpu.reg32[4] = afterRet - 0x40;
    call("SwitchToFiber", main);
    expect(Array.from(cpu.reg32.slice(3, 8))).toEqual([0xB1, callerEsp, 0xB5, 0xB6, 0xB7]);
    expect(u32(cpu.reg32[4])).toBe(0x402222);
    expect(u32(TEB + 0)).toBe(0x5000);
    expect(u32(TEB + 4)).toBe(0x40000);
    expect(u32(TEB + 8)).toBe(0x20000);
    expect(u32(TEB + 0x10)).toBe(main);
});

test("SwitchToFiber to something that is not a fiber changes nothing", () => {
    call("ConvertThreadToFiber", 0);
    cpu.reg32[4] = 0x3FF00;
    expect(call("SwitchToFiber", 0x12345678)).toBe(0);
    expect(cpu.reg32[4]).toBe(0x3FF00);
});

test("ConvertFiberToThread clears FiberData", () => {
    call("ConvertThreadToFiber", 0);
    expect(call("ConvertFiberToThread")).toBe(1);
    expect(u32(TEB + 0x10)).toBe(0);
    expect(call("ConvertFiberToThread")).toBe(0);
});

test("the fiber object describes itself, so a switch works with no host-side record of it", () => {
    const main = call("ConvertThreadToFiber", 0);
    const f = call("CreateFiber", 0, 0x401000, 7);
    resetFiberState();
    system.process.resetGeneration = 1;
    cpu.reg32[4] = 0x3FF00;
    expect(call("IsThreadAFiber")).toBe(1);
    expect(call("SwitchToFiber", f).skipStackCheck).toBe(true);
    expect(u32(TEB + 0x10)).toBe(f);
    expect(call("SwitchToFiber", main).skipStackCheck).toBe(true);
    expect(cpu.reg32[4]).toBe(0x3FF00);
});

test("a fiber stack is the image reserve, an explicit reserve, or the commit when that is larger", () => {
    const span = (f: number) => u32(f + 0x08) - u32(f + 0x0C);
    expect(span(call("CreateFiber", 0, 0x401000, 0))).toBe(0x100000);
    imageReserve = 0x40000;
    expect(span(call("CreateFiber", 0, 0x401000, 0))).toBe(0x40000);
    expect(span(call("CreateFiber", 0x1000, 0x401000, 0))).toBe(0x40000);
    expect(span(call("CreateFiber", 0x90000, 0x401000, 0))).toBe(0x90000);
    expect(span(call("CreateFiberEx", 0x1000, 0x20000, 0, 0x401000, 0))).toBe(0x20000);
    expect(span(call("CreateFiberEx", 0x1000, 0x12345, 0, 0x401000, 0))).toBe(0x20000);
    lastError = 0;
    expect(call("CreateFiberEx", 0, 0x80000000, 0, 0x401000, 0)).toBe(0);
    expect(lastError).toBe(8);
    expect(call("CreateFiber", 0xC0000000, 0x401000, 0)).toBe(0);
});

test("DeleteFiber frees an idle fiber and its stack; the pointer is no fiber afterwards", () => {
    call("ConvertThreadToFiber", 0);
    const f = call("CreateFiber", 0, 0x401000, 0);
    const stack = u32(f + 0x0C);
    call("DeleteFiber", f);
    expect(freed).toEqual([stack, f]);
    cpu.reg32[4] = 0x3FF00;
    expect(call("SwitchToFiber", f)).toBe(0);
    call("DeleteFiber", f);
    expect(freed.length).toBe(2);
});

test("DeleteFiber on the running fiber leaves through the thread-exit stub with exit code 1", () => {
    call("ConvertThreadToFiber", 0);
    const f = call("CreateFiber", 0, 0x401000, 0);
    cpu.reg32[4] = 0x3FF00;
    call("SwitchToFiber", f);
    const esp = cpu.reg32[4] >>> 0;
    dv.setUint32(esp, 0x402222, true);
    const r = call("DeleteFiber", f);
    expect(r).toEqual({ value: 1, skipStackCheck: true });
    expect(u32(esp)).toBe(EXIT_STUB);
    expect(mem[cpu.instruction_pointer[0] >>> 0]).toBe(0xC2);
    expect(u32(TEB + 0x10)).toBe(0);
    expect(freed).toEqual([f]);
});
