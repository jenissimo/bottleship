/**
 * Characterization harness — the guest FS base lives in TWO places and a context
 * switch must write BOTH.
 *
 * `cpu.segment_offsets[4]` is the base v86 cached when FS was last loaded; GDT entry 3
 * (guest 0x7e18) is what it re-derives the base from on the NEXT FS selector load. Writing
 * only the cache means an ordinary `push fs … pop fs` epilogue (Borland/Delphi RTL) resets
 * the base to 0, after which every `fs:[…]` reads linear 0 — the Delphi RTL's SEH setup
 * is the first thing to fault on it.
 *
 * Runs against a real `new Scheduler()` with a fake V86Cpu and a fake guest memory bound
 * into Mem — no v86, no DOM.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { setFsBase, readFsDescriptorBase } from "../../src/worker/core/scheduler/fs-base";
import { createInitialContext } from "../../src/worker/core/scheduler/scheduler-context";
import {
    ThreadState,
    ThunkBoundaryKind,
    type Thread,
    type V86Cpu,
} from "../../src/worker/core/scheduler/types";
import { GDT_FS_DESCRIPTOR_ADDRESS, createGDT } from "../../src/worker/core/bootloader";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

// 64 KB of low memory is enough to hold the GDT at 0x7e00.
let guestMem: Uint8Array;

/** Lay the real bootloader GDT down at its real address, exactly as boot does. */
function resetGuestMemory(): void {
    guestMem = new Uint8Array(0x10000);
    const { gdt, gdtAddress } = createGDT();
    guestMem.set(gdt, gdtAddress);
    Mem.bind(() => guestMem);
}

/** Decode the descriptor straight from bytes — an oracle independent of fs-base.ts. */
function decodeDescriptorBase(mem: Uint8Array, addr: number): number {
    return ((mem[addr + 7] << 24) | (mem[addr + 4] << 16) | (mem[addr + 3] << 8) | mem[addr + 2]) >>> 0;
}

function fakeCpu(init: { eip?: number; esp?: number } = {}): V86Cpu {
    const reg32 = new Int32Array(8);
    const instruction_pointer = new Int32Array(1);
    const flags = new Int32Array(1);
    const sreg = new Int16Array(8);
    const segment_offsets = new Int32Array(8); // index 4 = FS base (TEB)
    const instruction_counter = new Int32Array(1);
    instruction_counter[0] = 10_000_000;
    reg32[4] = init.esp ?? 0;
    instruction_pointer[0] = init.eip ?? 0;
    return { reg32, instruction_pointer, flags, sreg, segment_offsets, instruction_counter, is_jumping: false } as unknown as V86Cpu;
}

function mkThread(id: number, state: ThreadState): Thread {
    return {
        id,
        handle: 0x1000 + id,
        state,
        context: null,
        stackBase: 0x00200000,
        stackSize: 0x00100000,
        stackTop: 0x00300000,
        startAddress: 0x00401000,
        parameter: 0,
        waitInfo: null,
        exitCode: null,
        tlsValues: new Map(),
        lastError: 0,
        suspendCount: 0,
        priority: 0,
        lastSwitchTime: 0,
        lastSwitchInsn: 0,
        tebAddress: 0,
        kernelPinCount: 0,
        apcQueue: [],
        quitPosted: false,
        quitExitCode: 0,
        asyncParkGeneration: 0,
    };
}

function inject(s: Scheduler, t: Thread, opts: { runnable?: boolean; current?: boolean } = {}): Thread {
    const any = s as any;
    any.threads.set(t.id, t);
    if (opts.runnable && !any.runQueue.includes(t.id)) any.runQueue.push(t.id);
    if (opts.current) any.currentThreadId = t.id;
    return t;
}

beforeEach(() => resetGuestMemory());

describe("scheduler/setFsBase — the single FS-base writer", () => {
    test("the bootloader GDT ships an FS descriptor with base 0 (the state the bug relies on)", () => {
        expect(decodeDescriptorBase(guestMem, GDT_FS_DESCRIPTOR_ADDRESS)).toBe(0);
    });

    test("writes BOTH the cached base and the GDT descriptor", () => {
        const cpu = fakeCpu();
        setFsBase(cpu, 0x01100530);

        expect((cpu as any).segment_offsets[4] >>> 0).toBe(0x01100530);
        expect(decodeDescriptorBase(guestMem, GDT_FS_DESCRIPTOR_ADDRESS)).toBe(0x01100530);
        expect(readFsDescriptorBase()).toBe(0x01100530);
    });

    test("all three base fields are covered, including a base above 16 MB", () => {
        const cpu = fakeCpu();
        setFsBase(cpu, 0xdeadbeef);
        expect(readFsDescriptorBase()).toBe(0xdeadbeef);
        // byte-level: 15:0 at +2/+3, 23:16 at +4, 31:24 at +7
        expect(guestMem[GDT_FS_DESCRIPTOR_ADDRESS + 2]).toBe(0xef);
        expect(guestMem[GDT_FS_DESCRIPTOR_ADDRESS + 3]).toBe(0xbe);
        expect(guestMem[GDT_FS_DESCRIPTOR_ADDRESS + 4]).toBe(0xad);
        expect(guestMem[GDT_FS_DESCRIPTOR_ADDRESS + 7]).toBe(0xde);
    });

    test("leaves limit and type/flag bits alone — only the base fields move", () => {
        const pristine = guestMem.slice(GDT_FS_DESCRIPTOR_ADDRESS, GDT_FS_DESCRIPTOR_ADDRESS + 8);
        setFsBase(fakeCpu(), 0x7fff0000);
        const after = guestMem.slice(GDT_FS_DESCRIPTOR_ADDRESS, GDT_FS_DESCRIPTOR_ADDRESS + 8);
        for (const i of [0, 1, 5, 6]) expect(after[i]).toBe(pristine[i]);
        // Still a present, 32-bit, 4GB-granular data segment.
        expect(after[5]).toBe(0x92);
        expect(after[6]).toBe(0xcf);
    });

    test("a later switch to a base of 0 clears the descriptor too (no stale TEB)", () => {
        const cpu = fakeCpu();
        setFsBase(cpu, 0x01100530);
        setFsBase(cpu, 0);
        expect(readFsDescriptorBase()).toBe(0);
        expect((cpu as any).segment_offsets[4] >>> 0).toBe(0);
    });
});

describe("scheduler/performSwitch — FS descriptor follows the resumed thread", () => {
    test("after a switch, GDT entry 3's base equals the resumed thread's TEB", () => {
        const s = new Scheduler();
        inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        const t2 = mkThread(2, ThreadState.READY);
        t2.tebAddress = 0x01100530;
        t2.context = createInitialContext(0x00402000, 0x00290000);
        inject(s, t2, { runnable: true });

        const cpu = fakeCpu({ eip: 0x00401000, esp: 0x0028ff00 });
        expect((s as any).performSwitch(cpu, ThunkBoundaryKind.GUEST_CODE, 0)).toBe(true);

        // The invariant under test: not just the cached base, but the descriptor the CPU
        // re-reads on the next `pop fs`.
        expect((cpu as any).segment_offsets[4] >>> 0).toBe(t2.tebAddress);
        expect(decodeDescriptorBase(guestMem, GDT_FS_DESCRIPTOR_ADDRESS)).toBe(t2.tebAddress);
    });

    test("switching back and forth reprograms the descriptor each time", () => {
        const s = new Scheduler();
        const t1 = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        t1.tebAddress = 0x01000000;
        const t2 = mkThread(2, ThreadState.READY);
        t2.tebAddress = 0x02000000;
        t2.context = createInitialContext(0x00402000, 0x00290000);
        inject(s, t2, { runnable: true });

        const cpu = fakeCpu({ eip: 0x00401000, esp: 0x0028ff00 });
        expect((s as any).performSwitch(cpu, ThunkBoundaryKind.GUEST_CODE, 0)).toBe(true);
        expect(decodeDescriptorBase(guestMem, GDT_FS_DESCRIPTOR_ADDRESS)).toBe(0x02000000);

        // T1 was parked READY with a context; schedule it back in.
        expect((s as any).performSwitch(cpu, ThunkBoundaryKind.GUEST_CODE, 0)).toBe(true);
        expect((s as any).currentThreadId).toBe(1);
        expect(decodeDescriptorBase(guestMem, GDT_FS_DESCRIPTOR_ADDRESS)).toBe(0x01000000);
    });
});
