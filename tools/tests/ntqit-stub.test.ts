// NtQueryInformationThread(GetCurrentThread(), ThreadBasicInformation) answered in guest code
// (ntdll/thread-information writeThreadInformationStub) must write exactly what the JS
// handler writes, and must hand every other shape to that handler. The same script runs in
// real v86 twice: through the stub, and through a plain OUT-trap thunk that reaches the JS
// handler. Every status, every output DWORD and the stack must agree; the stub arm must
// cross into JS only where the script says it may.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Scheduler } from '../../src/worker/core/scheduler/scheduler';
import { ThreadState, type Thread } from '../../src/worker/core/scheduler/types';
import { System } from '../../src/worker/core/system';
import { queryThreadBasicInformation, writeThreadInformationStub } from '../../src/worker/modules/ntdll/thread-information';
import { exports as processApi } from '../../src/worker/modules/kernel32/process/process';
import type { StubAllocator } from '../../src/worker/core/thunking/thunk-memory-manager';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { AddressSpace } from '../../src/worker/core/memory/address-space';

const lib = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const wasm = fileURLToPath(new URL('../../public/v86.wasm', import.meta.url));

const BASE = 0x400000, ENTRY = BASE + 0x40, STUBS = BASE + 0x4000, RES = BASE + 0x6000, IMG = 0x8000;
const OFFSTACK = BASE + 0x7000;          // writable, but not the thread's stack
const BELOW = 0x0F0000;                  // writable, just under the thread's StackLimit
const MARK = BASE + 0x7800;              // index of the call in flight, read by the trap handler
const STACK = 0x200000, HEAP = 0x800000, CTL = 0x900, FID = 4242;
const CURRENT = 0xFFFFFFFE;
const NORMAL_PRIORITY_CLASS = 0x20, HIGH_PRIORITY_CLASS = 0x80;

type Buf = 'stack' | 'offstack' | 'below' | 'stack+2';
interface Call { handle: 'current' | 'real'; cls: number; len: number; buf: Buf; retLen: 'none' | 'stack' | 'offstack'; cross: boolean }
type Step = { call: Call } | { js: string; run(s: Scheduler): void };

const call = (over: Partial<Call>, cross: boolean): Step =>
    ({ call: { handle: 'current', cls: 0, len: 28, buf: 'stack', retLen: 'stack', ...over, cross } });
const js = (label: string, run: (s: Scheduler) => void): Step => ({ js: label, run });

const SCRIPT: Step[] = [
    call({}, true),                                   // mirror unknown: JS answers and publishes it
    call({}, false),                                  // answered in guest code
    call({ retLen: 'none' }, false),
    js('SetThreadPriority(current, 2)', () => processApi.SetThreadPriority!(null as never, new Uint8Array(0), [CURRENT, 2])),
    call({}, true),                                   // the change took the thread back to JS
    call({}, false),
    js('SetPriorityClass(HIGH)', () => processApi.SetPriorityClass!(null as never, new Uint8Array(0), [0xFFFFFFFF, HIGH_PRIORITY_CLASS])),
    call({}, true),
    call({}, false),
    call({ buf: 'offstack' }, true),                  // not provably writable: JS probes it
    call({ buf: 'below' }, true),
    call({ retLen: 'offstack' }, true),
    call({ buf: 'stack+2' }, true),                   // misaligned: JS owns the status
    call({ cls: 1 }, true),
    call({ len: 24 }, true),
    call({ handle: 'real' }, true),
    js('SetPriorityClass(NORMAL)', () => processApi.SetPriorityClass!(null as never, new Uint8Array(0), [0xFFFFFFFF, NORMAL_PRIORITY_CLASS])),
    call({}, true),
    call({}, false),
    js('protect the stack page read-only', () => space().protect(STACK - 0x1000, 0x1000, 'r')),
    call({}, true),                                   // proof withdrawn: JS probes, refuses, publishes nothing
    call({}, true),
    call({ retLen: 'none' }, true),
    js('protect the stack page read-write again', () => space().protect(STACK - 0x1000, 0x1000, 'rw')),
    call({}, true),                                   // JS re-establishes the whole-stack proof
    call({}, false),
    js('protect another stack page read-only', () => space().protect(STACK - 0x8000, 0x1000, 'r')),
    call({}, true),                                   // this buffer is writable, but the stack is not: no proof
    call({}, true),
];

let liveSpace: AddressSpace | null = null;
const space = () => liveSpace!;

const calls = SCRIPT.flatMap((s, k) => 'call' in s ? [k] : []);
const SLOT = 64;                                      // per call: status + 7 dwords + retLen + esp

function image(viaStub: boolean, realHandle: number): Uint8Array {
    const mem = new Uint8Array(BASE + IMG), view = new DataView(mem.buffer);
    [0x1badb002, 0x10000, -(0x1badb002 + 0x10000), BASE, BASE, BASE + IMG, BASE + IMG, ENTRY]
        .forEach((v, i) => view.setUint32(BASE + i * 4, v >>> 0, true));
    let target: number;
    if (viaStub) {
        let bump = STUBS;
        const allocator: StubAllocator = { alloc(size: number) { const a = bump; bump += (size + 15) & ~15; return a; } };
        target = writeThreadInformationStub(allocator, () => mem, FID);
    } else {
        target = STUBS;
        mem.set([0xb8, FID & 0xff, FID >> 8, 0, 0, 0xba, 0x77, 0xb0, 0, 0, 0xef, 0xc2, 20, 0], STUBS);
    }
    let p = ENTRY;
    const e = (...b: number[]) => { for (const x of b) mem[p++] = x & 0xff; };
    const u = (v: number) => { view.setUint32(p, v >>> 0, true); p += 4; };
    e(0xbc); u(STACK);                                                    // mov esp, STACK
    e(0x83, 0xec, 0x40);                                                  // sub esp, 64: buffers live here
    SCRIPT.forEach((step, k) => {
        if ('js' in step) { e(0xb9); u(k); e(0xb8); u(CTL); e(0xba); u(0xb077); e(0xef); return; }
        const c = step.call, r = RES + k * SLOT;
        // Poison the output so a write that did not happen cannot pass as one.
        for (let i = 0; i < 8; i++) { e(0xc7, 0x44, 0x24, i * 4); u(0xcccccccc); }
        e(0xc7, 0x44, 0x24, 0x20); u(0xcccccccc);                         // [esp+32] = retLen slot
        for (let i = 0; i < 8; i++) { e(0xc7, 0x05); u(OFFSTACK + i * 4); u(0xcccccccc); e(0xc7, 0x05); u(BELOW + i * 4); u(0xcccccccc); }
        e(0xc7, 0x05); u(MARK); u(k);
        // push args right to left: retLen, len, buf, class, handle
        if (c.retLen === 'none') { e(0x6a, 0x00); }
        else if (c.retLen === 'offstack') { e(0x68); u(OFFSTACK + 28); }
        else { e(0x8d, 0x44, 0x24, 0x20); e(0x50); }                      // lea eax,[esp+32]; push eax
        e(0x6a, c.len);
        if (c.buf === 'offstack' || c.buf === 'below') { e(0x68); u(c.buf === 'below' ? BELOW : OFFSTACK); }
        else { e(0x8d, 0x44, 0x24, c.buf === 'stack+2' ? 0x0a : 0x08); e(0x50); } // &[esp+0 or +2] before the pushes
        e(0x6a, c.cls);
        e(0x68); u(c.handle === 'current' ? CURRENT : realHandle);
        e(0xb8); u(0xdeadbeef);
        e(0xe8); u(target - (p + 4));
        e(0xa3); u(r);                                                    // status
        e(0x89, 0x25); u(r + 40);                                         // esp after the call
        const ext = c.buf === 'offstack' ? OFFSTACK : c.buf === 'below' ? BELOW : 0;
        for (let i = 0; i < 7; i++) {                                     // copy the 7 output dwords
            if (ext) { e(0x8b, 0x0d); u(ext + i * 4); }
            else { e(0x8b, 0x4c, 0x24, (c.buf === 'stack+2' ? 2 : 0) + i * 4); }
            e(0x89, 0x0d); u(r + 4 + i * 4);
        }
        if (c.retLen === 'offstack') { e(0x8b, 0x0d); u(OFFSTACK + 28); } else { e(0x8b, 0x4c, 0x24, 0x20); }
        e(0x89, 0x0d); u(r + 32);
    });
    e(0xf4);
    return mem.slice(BASE);
}

function thread(id: number): Thread {
    return {
        id, handle: 0, state: ThreadState.RUNNING, context: null, stackBase: 0x100000,
        stackSize: 0x100000, stackTop: STACK, startAddress: ENTRY, parameter: 0, waitInfo: null,
        exitCode: null, tlsValues: new Map(), lastError: 0, suspendCount: 0, priority: 0,
        lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0, kernelPinCount: 0,
        apcQueue: [], quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
    } as Thread;
}

interface Arm { rows: number[][]; crossings: boolean[] }

async function runArm(viaStub: boolean): Promise<Arm> {
    const g = globalThis as { window?: unknown };
    const hadWindow = 'window' in g, savedWindow = g.window;
    delete g.window;
    const system = System.getInstance();
    const saved = { scheduler: system.scheduler, process: system.process };
    processApi.SetPriorityClass!(null as never, new Uint8Array(0), [0xFFFFFFFF, NORMAL_PRIORITY_CLASS]);
    const { V86 } = await import(lib);
    const em = new V86({ autostart: false, memory_size: 32 << 20, wasm_path: wasm, log_level: 0, disable_jit: 1 });
    try {
        await new Promise<void>(resolve => em.add_listener('emulator-loaded', resolve));
        const cpu = em.v86.cpu;
        const mem = () => new Uint8Array(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
        Mem.bind(mem);
        let bump = HEAP;
        const memory = { alloc: (size: number) => { const a = bump; bump += (size + 0xfff) & ~0xfff; return a; } };
        const s = new Scheduler();
        s.tebManager.initProcess(mem, memory);
        (s as any).process = { memory };
        system.scheduler = s;
        const addressSpace = new AddressSpace(mem);
        addressSpace.mapRegion(0x100000, (32 << 20) - 0x100000, 'rwx', 'HEAP', 'test', 'all');
        addressSpace.onAccessChange = (b, size) => s.forgetPriorityMirrorsOverlapping(b, size);
        liveSpace = addressSpace;
        system.process = { resetGeneration: 0, memory, getCurrentMemory: mem, addressSpace } as never;
        const rp = (s as any).resourceProvider;
        const t = thread(1);
        const realHandle = rp.registerKernelObject({ kind: 'thread', threadId: 1 }) >>> 0;
        t.handle = realHandle;
        cpu.reboot_internal(); cpu.reset_memory(); cpu.load_multiboot(image(viaStub, realHandle).buffer);
        t.tebAddress = s.tebManager.allocateTeb(1, t.stackBase, t.stackTop, memory);
        (s as any).threads.set(1, t);
        (s as any).currentThreadId = 1;
        cpu.segment_offsets[4] = t.tebAddress; cpu.segment_is_null[4] = 0;

        const crossings: boolean[] = SCRIPT.map(() => false);
        cpu.io.register_write(0xb077, null, undefined, undefined, (fid: number) => {
            if (fid === CTL) {
                const k = cpu.reg32[1] >>> 0, step = SCRIPT[k];
                if (!('js' in step)) throw new Error(`step ${k} is not a JS step`);
                step.run(s);
                return;
            }
            if (fid !== FID) throw new Error(`unexpected OUT ${fid}`);
            const esp = cpu.reg32[4] >>> 0;
            const args = Array.from({ length: 5 }, (_, i) => cpu.read32s(esp + 4 + i * 4) >>> 0);
            crossings[cpu.read32s(MARK) >>> 0] = true;
            cpu.reg32[0] = Number(queryThreadBasicInformation(null as never, mem(), args)) >>> 0;
        });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { em.stop(); reject(new Error('guest did not halt')); }, 15000);
            em.bus.register('cpu-event-halt', () => { clearTimeout(timer); em.stop(); resolve(); });
            cpu.reg32[4] = STACK; cpu.instruction_pointer[0] = ENTRY; cpu.flags[0] = 2;
            em.run();
        });
        const r32 = (a: number) => cpu.read32s(a) >>> 0;
        return { rows: calls.map(k => Array.from({ length: 11 }, (_, i) => r32(RES + k * SLOT + i * 4))), crossings };
    } finally {
        await em.destroy();
        system.scheduler = saved.scheduler;
        system.process = saved.process;
        processApi.SetPriorityClass!(null as never, new Uint8Array(0), [0xFFFFFFFF, NORMAL_PRIORITY_CLASS]);
        if (hadWindow) g.window = savedWindow;
    }
}

describe.skipIf(!existsSync(lib) || !existsSync(wasm))('NtQueryInformationThread guest stub, executed', () => {
    test('writes exactly what the JS handler writes and defers every other shape to it', async () => {
        const viaTrap = await runArm(false);
        const viaStub = await runArm(true);
        expect(viaStub.rows).toEqual(viaTrap.rows);
        // Explicit expectations, so the two arms cannot be wrong together.
        const k0 = calls.indexOf(1);
        expect(viaStub.rows[k0]![0]).toBe(0);                     // STATUS_SUCCESS
        expect(viaStub.rows[k0]![1]).toBe(0x103);                 // ExitStatus of a running thread
        expect(viaStub.rows[k0]![4]).toBe(1);                     // ClientId.UniqueThread
        expect(viaStub.rows[k0]![5]).toBe(1);                     // AffinityMask
        expect(viaStub.rows[k0]![8]).toBe(28);                    // ReturnLength
        const after2 = calls.indexOf(5);
        expect(viaStub.rows[after2]![7]).toBe(2);                 // BasePriority follows SetThreadPriority
        const offStack = calls.indexOf(9);
        expect(viaStub.rows[offStack]![0]).toBe(0);
        expect(viaStub.rows[calls.indexOf(12)]![0]).toBe(0x80000002);  // misaligned
        expect(viaStub.rows[calls.indexOf(13)]![0]).toBe(0xc0000002);  // other class
        expect(viaStub.rows[calls.indexOf(14)]![0]).toBe(0xc0000004);  // other length
        for (const row of viaStub.rows) expect(row[10]).toBe(STACK - 0x40);  // RET 20 popped the args
        const roAt = SCRIPT.findIndex(s => 'js' in s && s.js.startsWith('protect the stack page read-only'));
        expect(viaStub.rows[calls.indexOf(roAt + 1)]![0]).toBe(0xc0000005);  // STATUS_ACCESS_VIOLATION, not a write
        expect(viaStub.rows[calls.indexOf(roAt + 3)]![0]).toBe(0xc0000005);
        // Crossings: the trap arm crosses on every call; the stub arm exactly where the script says.
        expect(calls.map(k => viaTrap.crossings[k])).toEqual(calls.map(() => true));
        expect(calls.map(k => viaStub.crossings[k])).toEqual(calls.map(k => (SCRIPT[k] as { call: Call }).call.cross));
    }, 60000);
});
