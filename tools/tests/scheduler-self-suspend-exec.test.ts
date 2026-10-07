import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Scheduler } from '../../src/worker/core/scheduler/scheduler';
import { ThreadState, ThunkBoundaryKind, type Thread } from '../../src/worker/core/scheduler/types';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { SHIPPING_JIT, applyCodegenSwitches } from '../jit-config/shipping.mjs';

const lib = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const wasm = fileURLToPath(new URL('../../public/v86.wasm', import.meta.url));
const BASE = 0x400000, ENTRY = BASE + 0x40, DONE = BASE + 0x80;
const STUB = BASE + 0x1000, RESULT = BASE + 0x2000;
const WRAPPER = STUB + 0x100, RETURN = WRAPPER + 10;
const OUT_STACK = 0x200000;

function thread(id: number, state: ThreadState): Thread {
    return {
        id, handle: id, state, context: null, stackBase: id * 0x100000,
        stackSize: 0x100000, stackTop: (id + 1) * 0x100000,
        startAddress: ENTRY, parameter: 0, waitInfo: null, exitCode: null,
        tlsValues: new Map(), lastError: 0, suspendCount: 0, priority: 0,
        lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0, kernelPinCount: 0,
        apcQueue: [], quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
    };
}

function image(): Uint8Array {
    const bytes = new Uint8Array(0x3000), view = new DataView(bytes.buffer);
    [0x1badb002, 0x10000, -(0x1badb002 + 0x10000), BASE, BASE,
        BASE + bytes.length, BASE + bytes.length, ENTRY]
        .forEach((v, i) => view.setUint32(i * 4, v >>> 0, true));
    let p = ENTRY - BASE;
    bytes[p++] = 0xe8; view.setInt32(p, WRAPPER - (BASE + p + 4), true); p += 4;
    bytes[p++] = 0x4f; bytes[p++] = 0x75; bytes[p] = ENTRY - (BASE + p + 1); p++;
    bytes[p++] = 0xe9; view.setInt32(p, DONE - (BASE + p + 4), true);
    bytes[DONE - BASE] = 0xf4;
    bytes.set([0xb8, 1, 0, 0, 0, 0xba, 0x77, 0xb0, 0, 0, 0xef, 0xc2, 4, 0], STUB - BASE);
    p = WRAPPER - BASE;
    bytes[p++] = 0x68; view.setUint32(p, 0x1234, true); p += 4;
    bytes[p++] = 0xe8; view.setInt32(p, STUB - (BASE + p + 4), true); p += 4;
    // Common C++ HANDLE wrapper: translate the kernel result to bool, then RET.
    bytes.set([0x31, 0xc9, 0x83, 0xf8, 0xff, 0x0f, 0x95, 0xc1, 0x89, 0xc8], p); p += 10;
    bytes.set([0xc7, 0x05], p); p += 2;
    view.setUint32(p, RESULT + 12, true); p += 4;
    view.setUint32(p, 1, true); p += 4;
    bytes[p] = 0xc3;
    return bytes;
}

// Execute caller code in v86 so bookkeeping alone cannot conceal a suspended
// thread continuing past the OUT trap.
describe.skipIf(!existsSync(lib) || !existsSync(wasm))('scheduler self-suspend, executed', () => {
    for (const jit of [false, true]) {
        test(`self-suspend with no runnable peer executes no caller code until resumed (JIT=${jit})`, async () => {
            const g = globalThis as { window?: unknown };
            const hadWindow = 'window' in g, savedWindow = g.window;
            delete g.window;
            const { V86 } = await import(lib);
            const em = new V86({ autostart: false, memory_size: 32 << 20,
                wasm_path: wasm, log_level: 0, disable_jit: jit ? 0 : 1 });
            try {
                await new Promise<void>(resolve => em.add_listener('emulator-loaded', resolve));
                const cpu = em.v86.cpu, api = cpu.wm.exports;
                cpu.reboot_internal(); cpu.reset_memory(); cpu.load_multiboot(image().buffer);
                for (const [index, value] of SHIPPING_JIT) api.set_jit_config(index, value);
                applyCodegenSwitches(api);
                let finalized = 0;
                cpu.test_hook_did_finalize_wasm = () => finalized++;
                const mem = () => new Uint8Array(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
                Mem.bind(mem);
                const s = new Scheduler();
                (s as any).process = { getCurrentMemory: mem };
                // HLT stands in for the production JMP-$ parking address so execution
                // completes deterministically without a timer pretending to be a guest.
                (s as any).spinLoopBase = DONE;
                (s as any).spinLoopEnd = DONE + 2;
                const t = thread(1, ThreadState.RUNNING);
                (s as any).threads.set(1, t); (s as any).currentThreadId = 1;
                (s as any).threads.set(2, thread(2, ThreadState.WAITING));
                let suspend = false;
                cpu.io.register_write(0xb077, null, undefined, undefined, () => {
                    if (!suspend) return;
                    cpu.reg32[0] = s.suspendThread(t.handle);
                    (s as any).performSwitch(cpu, ThunkBoundaryKind.THUNK_STUB, 4);
                });
                const run = () => new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => { em.stop(); reject(new Error('guest did not halt')); }, 10000);
                    const halt = () => { clearTimeout(timer); em.stop(); em.bus.unregister('cpu-event-halt', halt); resolve(); };
                    em.bus.register('cpu-event-halt', halt); em.run();
                });
                cpu.reg32[4] = OUT_STACK; cpu.reg32[7] = jit ? 50000 : 1;
                cpu.instruction_pointer[0] = ENTRY; cpu.flags[0] = 2;
                await run(); await Bun.sleep(0);
                if (jit) {
                    expect(finalized).toBeGreaterThan(0);
                    const entries = Array.from({ length: api.jit_aot_page_entry_count(STUB) }, (_, i) =>
                        api.jit_aot_page_entry_at(STUB, i) >>> 16);
                    expect(entries).toContain((STUB + 11) & 0xfff);
                }
                const view = () => new DataView(mem().buffer, mem().byteOffset);
                view().setUint32(RESULT + 12, 0, true);
                suspend = true;
                cpu.reg32[4] = OUT_STACK; cpu.reg32[7] = 1;
                cpu.instruction_pointer[0] = ENTRY; cpu.in_hlt[0] = 0;
                await run();
                expect(t.state).toBe(ThreadState.SUSPENDED);
                expect(t.context?.eip).toBe(RETURN);
                expect(t.context?.esp).toBe(OUT_STACK - 4);
                expect(t.context?.eax).toBe(0);
                expect(view().getUint32(RESULT + 12, true)).toBe(0);

                expect(s.resumeThread(t.handle)).toBe(1);
                expect((s as any).performSwitch(cpu, ThunkBoundaryKind.GUEST_CODE, 0)).toBe(true);
                cpu.in_hlt[0] = 0;
                await run();
                expect(view().getUint32(RESULT + 12, true)).toBe(1);
                expect(cpu.reg32[4] >>> 0).toBe(OUT_STACK);
                expect(cpu.reg32[0]).toBe(1);
                expect(t.state).toBe(ThreadState.RUNNING);
            } finally {
                await em.destroy();
                if (hadWindow) g.window = savedWindow;
            }
        }, 20000);
    }
});
