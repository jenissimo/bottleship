// The production binding of the kernel32 TEB stubs: PELoader.emitTebStubs picks the trap
// ids, redirects the in-image export bodies and binds the hypercall routing, and
// GetProcAddress then hands out the one address whose body jumps to the stub. The trap
// tails must be the exact OUT-trap stub the ThunkGenerator registered for that export —
// its functionId (what the dispatcher keys on) and its RET N (the descriptor's stack
// cleanup) — or a thread without a TLS array returns with the wrong handler's answer
// or a skewed stack.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hleImageBase, materializeHleModuleImages, resetHleModuleImages } from "../../src/worker/core/hle-module-images";
import { hleExportBindingAddress } from "../../src/worker/core/thunking/export-resolver";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { preemptionManager } from "../../src/worker/core/cpu/preemption-manager";
import { resetGuestCodeInvalidationState } from "../../src/worker/core/memory/guest-code";
import { MEM_HLE_IMAGE_BASE, MEM_HLE_IMAGE_SIZE } from "../../src/worker/core/cpu/emulator-config";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { System } from "../../src/worker/core/system";
import { PELoader } from "../../src/worker/core/pe-loader";
import { hypercallDataManager } from "../../src/worker/core/cpu/hypercall-data";
import { kernel32Module } from "../../src/worker/api/kernel32.api";
import { exports as kernel32 } from "../../src/worker/modules/kernel32/module/module";
import type { TebInlineStubs } from "../../src/worker/modules/kernel32/teb-stubs";

const NAME = 0x10000, ESP = 0x11000, STUB_ARENA = 0x40000;
let mem: Uint8Array;
let gen: ThunkGenerator;
let stubs: TebInlineStubs;
let savedExports: unknown, savedProcess: unknown;

function getProcAddress(hModule: number, proc: string): number {
    for (let i = 0; i < proc.length; i++) mem[NAME + i] = proc.charCodeAt(i);
    mem[NAME + proc.length] = 0;
    const r = kernel32["GetProcAddress"]!({ esp: ESP, eip: 0 } as never, mem, [hModule, NAME]) as any;
    return (typeof r === "number" ? r : r.value) >>> 0;
}

beforeAll(() => {
    APIRegistry.getInstance().registerModule(kernel32Module);
    mem = new Uint8Array(MEM_HLE_IMAGE_BASE + MEM_HLE_IMAGE_SIZE);
    Mem.bind(() => mem);
    savedExports = (preemptionManager as unknown as { wasmExports: unknown }).wasmExports;
    (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = {
        jit_dirty_cache: () => { }, jit_clear_cache_js: () => { },
    };
    savedProcess = System.getInstance().process;
    gen = new ThunkGenerator();
    gen.setBaseAddress(0x21046000);
    let bump = STUB_ARENA;
    const process: any = {
        thunkGenerator: gen, resetGeneration: Math.random(), lastError: 0,
        dispatcher: { thunkGenerator: gen, pendingRegistrations: new Map() },
        getCurrentMemory: () => mem,
        thunkMemoryManager: { stubAllocator: { alloc(size: number) { const a = bump; bump += (size + 15) & ~15; return a; } } },
    };
    (System.getInstance() as any).process = process;
    materializeHleModuleImages(process);
    const loader = new PELoader(() => mem, gen, APIRegistry.getInstance());
    stubs = (loader as unknown as { emitTebStubs(t: Map<string, number>): TebInlineStubs | null })
        .emitTebStubs(new Map())!;
});

afterAll(() => {
    hypercallDataManager.setTebStubsBound(false);
    (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = savedExports;
    (System.getInstance() as any).process = savedProcess;
    resetGuestCodeInvalidationState();
    resetHleModuleImages();
});

const EXPORTS: Array<[string, keyof TebInlineStubs]> = [
    ["GetLastError", "getLastErrorStub"], ["SetLastError", "setLastErrorStub"],
    ["TlsGetValue", "tlsGetValueStub"], ["TlsSetValue", "tlsSetValueStub"],
    ["FlsGetValue", "flsGetValueStub"], ["FlsSetValue", "flsSetValueStub"],
];

describe("kernel32 TEB stub binding", () => {
    test("emission binds the hypercall routing", () => {
        expect(stubs).not.toBeNull();
        expect(hypercallDataManager.areTebStubsBound()).toBe(true);
    });

    for (const [name, field] of EXPORTS) {
        test(`GetProcAddress("${name}") is the export's one address, and its body jumps to the stub`, () => {
            const kernel = hleImageBase("kernel32")!;
            const addr = getProcAddress(kernel, name);
            expect(addr).toBe(hleExportBindingAddress(gen, "kernel32", name)!);
            const dv = new DataView(mem.buffer);
            expect(mem[addr]).toBe(0xe9);
            expect((addr + 5 + dv.getInt32(addr + 1, true)) >>> 0).toBe(stubs[field]);
        });
    }

    test("each trap tail is the registered OUT-trap stub of its own export", () => {
        // B8 <fid> BA 77 B0 00 00 EF C2 <n> 00, in emission order.
        const tails: Array<{ fid: number; pop: number }> = [];
        const dv = new DataView(mem.buffer);
        for (let a = stubs.regionBase; a + 14 <= stubs.regionEnd; a++) {
            if (mem[a] === 0xb8 && mem[a + 5] === 0xba && mem[a + 6] === 0x77 && mem[a + 7] === 0xb0
                && mem[a + 10] === 0xef && mem[a + 11] === 0xc2) {
                tails.push({ fid: dv.getUint32(a + 1, true), pop: dv.getUint16(a + 12, true) });
            }
        }
        const named = tails.map(({ fid, pop }) => {
            const stub = gen.getStubById(fid);
            return { name: stub?.functionName, pop, cleanup: stub?.stackCleanupBytes };
        });
        expect(named).toEqual([
            { name: "TlsGetValue", pop: 4, cleanup: 4 },
            { name: "TlsSetValue", pop: 8, cleanup: 8 },
            { name: "FlsSetValue", pop: 8, cleanup: 8 },
        ]);
    });
});
