// Native loader TLS at FS:[2Ch] and dynamic TLS at E10/F94 have independent indices.
// A real loader template at implicit index zero survives writes to EVERY dynamic TLS index.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { ThreadState, type Thread } from "../../src/worker/core/scheduler/types";
import { System } from "../../src/worker/core/system";
import { IMPLICIT_TLS_FIRST, TLS_INDEX_LIMIT } from "../../src/worker/core/teb-manager";
import { exports as tlsApi } from "../../src/worker/modules/kernel32/tls";
import { hypercallDataManager } from "../../src/worker/core/cpu/hypercall-data";
import { PELoader } from "../../src/worker/core/pe-loader";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { APIRegistry } from "../../src/worker/core/api-registry";

/** Run the loader's own IMAGE_TLS_DIRECTORY processing for a module at IMAGE. */
const IMAGE = 0x40000, OPT = 0x100, TLS_RVA = 0x1000, INDEX_VAR = IMAGE + 0x1800;
function loadModuleWithTls(templateSize: number, zeroFill: number): number {
    const view = new DataView(mem.buffer);
    const pe = new DataView(new ArrayBuffer(0x200));
    pe.setUint32(OPT + 168, TLS_RVA, true); pe.setUint32(OPT + 172, 24, true);
    const dir = IMAGE + TLS_RVA;
    view.setUint32(dir, TEMPLATE, true); view.setUint32(dir + 4, TEMPLATE + templateSize, true);
    view.setUint32(dir + 8, INDEX_VAR, true); view.setUint32(dir + 12, 0, true); view.setUint32(dir + 16, zeroFill, true);
    const loader = new PELoader(() => mem, new ThunkGenerator(), APIRegistry.getInstance());
    (loader as unknown as { processTlsDirectory(v: DataView, o: number, b: number, n: string): void })
        .processTlsDirectory(pe, OPT, IMAGE, "mod");
    return view.getUint32(INDEX_VAR, true);
}

const TEMPLATE = 0x2000, HEAP = 0x10000;
const system = System.getInstance();
let saved: { scheduler: unknown; process: unknown; entries: unknown; tls: Uint8Array };
let mem: Uint8Array, s: Scheduler;

function thread(id: number): Thread {
    return {
        id, handle: id, state: ThreadState.RUNNING, context: null, stackBase: 0, stackSize: 0,
        stackTop: 0, startAddress: 0, parameter: 0, waitInfo: null, exitCode: null, tlsValues: new Map(),
        lastError: 0, suspendCount: 0, priority: 0, lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0,
        kernelPinCount: 0, apcQueue: [], quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
    };
}

beforeEach(() => {
    saved = {
        scheduler: system.scheduler, process: system.process, entries: system.implicitTlsEntries,
        tls: ((hypercallDataManager as any).tlsAllocatedShadow as Uint8Array).slice(),
    };
    mem = new Uint8Array(0x100000);
    let bump = HEAP;
    const memory = { alloc: (n: number) => { const a = bump; bump += (n + 0xfff) & ~0xfff; return a; } };
    s = new Scheduler();
    s.tebManager.initProcess(() => mem, memory);
    for (const id of [1, 2]) {
        const t = thread(id);
        t.tebAddress = s.tebManager.allocateTeb(id, 0, 0, memory);
        (s as any).threads.set(id, t);
    }
    (s as any).currentThreadId = 1;
    (s as any).process = { memory };
    system.scheduler = s;
    system.process = { memory, getCurrentMemory: () => mem } as never;
    system.implicitTlsEntries = [];
});

afterEach(() => {
    system.scheduler = saved.scheduler as never;
    system.process = saved.process as never;
    system.implicitTlsEntries = saved.entries as never;
    (hypercallDataManager as any).tlsAllocatedShadow.set(saved.tls);
});

describe("implicit TLS is out of TlsSetValue's reach", () => {
    test("TlsSetValue on every valid index leaves each thread's module block intact", () => {
        const template = [0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4];
        mem.set(template, TEMPLATE);
        const tlsIndex = loadModuleWithTls(template.length, 8);   // the module's _tls_index
        expect(tlsIndex).toBe(0);
        expect(tlsIndex).toBe(IMPLICIT_TLS_FIRST);
        expect(system.implicitTlsEntries.map(e => e.tlsIndex)).toEqual([tlsIndex]);

        const view = new DataView(mem.buffer);
        const blockOf = (tid: number) => {
            const array = view.getUint32(s.tebManager.getTebAddress(tid)! + 0x2c, true);
            return view.getUint32(array + tlsIndex * 4, true);
        };
        const before = [blockOf(1), blockOf(2)];
        expect(before.every(b => b !== 0)).toBe(true);
        expect(before[0]).not.toBe(before[1]);

        // TlsAlloc is no longer drained by implicit TLS: the guest's first index is 0.
        expect(Number(tlsApi.TlsAlloc!(null as never, mem, []))).toBe(0);
        for (const tid of [1, 2]) {
            (s as any).currentThreadId = tid;
            for (let i = 0; i < TLS_INDEX_LIMIT; i++) {
                expect(Number(tlsApi.TlsSetValue!(null as never, mem, [i, 0xbad0bad0]))).toBe(1);
            }
            // Same numerical index, different native storage: it remains a valid dynamic TLS write.
            expect(Number(tlsApi.TlsSetValue!(null as never, mem, [tlsIndex, 0xbad0bad0]))).toBe(1);
        }
        expect([blockOf(1), blockOf(2)]).toEqual(before);
        for (const block of before) {
            expect([...mem.subarray(block, block + 16)]).toEqual([...template, 0, 0, 0, 0, 0, 0, 0, 0]);
        }
    });

    test("a second module gets the next independent loader index", () => {
        const a = s.implicitTlsAlloc();
        system.implicitTlsEntries.push({ tlsIndex: a, templateStart: 0, templateSize: 0, zeroFillSize: 4, moduleName: "a" });
        expect(s.implicitTlsAlloc()).toBe(a + 1);
    });
});

test("all1088 historical loader indices are admitted independently of dynamic allocation", () => {
    for(let index=0;index<1088;index++) {
        expect(s.implicitTlsAlloc()).toBe(index);
        system.implicitTlsEntries.push({tlsIndex:index,templateStart:0,templateSize:0,zeroFillSize:4,moduleName:"m"+index});
    }
    expect(s.implicitTlsAlloc()).toBe(0xffffffff);
    expect(s.tlsAlloc()).toBe(0);
    expect(s.tlsAlloc()).toBe(1);
});
