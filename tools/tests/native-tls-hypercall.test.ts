// Real native hypercall contract: dynamic inline TLS is distinct from implicit TLS.
// The guest executes ordinary OUT stubs. Absolute per-call, ABI, thread, LastError
// and served/fallback ledgers prevent a skipped handler from looking correct.
import { describe, test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const LIB = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const WASM = fileURLToPath(new URL('../../public/v86.wasm', import.meta.url));
interface Step {
    api: 'get' | 'set';
    index: number;
    thread: number;
    want: number;
    served: boolean;
    value?: number;
    nullTeb?: boolean;
    overrideTeb?: number;
}
interface Check {
    name: string;
    actual: unknown;
    want: unknown;
    pass: boolean;
}
interface Outcome {
    checks: Check[];
    failed: Check[];
    error?: string;
    [key: string]: unknown;
}
const BASE = 0x400000, ENTRY = BASE + 0x40, STUBS = BASE + 0x4000, RES = BASE + 0x5000, STACK = 0x200000, TEBS = [0x800000, 0x802000], IMPLICIT = [0x810000, 0x812000];
const GET = 103, SET = 104, PORT = 0xb077, CTL = 0x8888;
const STEPS: Step[] = [
    { api: 'get', index: 0, thread: 0, want: 0x11110000, served: true },
    { api: 'set', index: 0, value: 0xbeef0000, thread: 0, want: 1, served: true },
    { api: 'get', index: 0, thread: 0, want: 0xbeef0000, served: true },
    { api: 'get', index: 63, thread: 0, want: 0x1111003f, served: true },
    { api: 'set', index: 63, value: 0xbeef003f, thread: 0, want: 1, served: true },
    { api: 'get', index: 63, thread: 0, want: 0xbeef003f, served: true },
    { api: 'get', index: 7, thread: 0, want: 0, served: true },
    { api: 'set', index: 7, value: 0xdead0007, thread: 0, want: 0xfeed0007, served: false },
    { api: 'get', index: 64, thread: 0, want: 0xfeed0040, served: false },
    { api: 'set', index: 64, value: 0xdead0040, thread: 0, want: 0xfeed0040, served: false },
    { api: 'get', index: 1088, thread: 0, want: 0xfeed0440, served: false },
    { api: 'get', index: 0, thread: 1, want: 0x11111000, served: true },
    { api: 'set', index: 0, value: 0xbeef1000, thread: 1, want: 1, served: true },
    { api: 'get', index: 0, thread: 0, want: 0xbeef0000, served: true },
    { api: 'get', index: 0, thread: 0, want: 0xfeed0000, served: false, nullTeb: true },
];
function image(steps: Step[]) {
    const mem = new Uint8Array(BASE + 0x8000), v = new DataView(mem.buffer);
    [0x1badb002, 0x10000, -(0x1badb002 + 0x10000), BASE, BASE, BASE + 0x8000, BASE + 0x8000, ENTRY].forEach((n, i) => v.setUint32(BASE + i * 4, n >>> 0, true));
    for (const [fid, pop, at] of [[GET, 4, STUBS], [SET, 8, STUBS + 32]])
        mem.set([0xb8, fid, 0, 0, 0, 0xba, 0x77, 0xb0, 0, 0, 0xef, 0xc2, pop, 0], at);
    let p = ENTRY;
    const e = (...b: number[]) => b.forEach(x => mem[p++] = x & 255), u = (x: number) => { v.setUint32(p, x >>> 0, true); p += 4; };
    const imm = (op: number, x: number) => { e(op); u(x); };
    const control = (phase: number, i: number) => { imm(0xb8, phase * 0x10000 + i); imm(0xba, CTL); e(0xef); };
    imm(0xbc, STACK);
    steps.forEach((s, i) => {
        control(1, i);
        imm(0xbb, 0xb0010000 + i);
        imm(0xbe, 0xb0020000 + i);
        imm(0xbf, 0xb0030000 + i);
        imm(0xbd, 0xb0040000 + i);
        if (s.api === 'set') {
            imm(0x68, s.value!);
        }
        imm(0x68, s.index);
        e(0xe8);
        u((s.api === 'get' ? STUBS : STUBS + 32) - (p + 4));
        e(0xa3);
        u(RES + i * 32);
        for (const [mod, off] of [[0x25, 4], [0x1d, 8], [0x35, 12], [0x3d, 16], [0x2d, 20]]) {
            e(0x89, mod);
            u(RES + i * 32 + off);
        }
        control(2, i);
    });
    e(0xf4);
    return mem.slice(BASE);
}
async function runArm(layout: 'alias' | 'disjoint', guards = false): Promise<Outcome> {
    const engine = WASM;
    const steps: Step[] = guards ? [
        { api: 'get', index: 0, thread: 0, want: 0xfeed0000, served: false, overrideTeb: 0xfffffff0 },
        { api: 'set', index: 0, value: 0xdeadbeef, thread: 0, want: 0xfeed0000, served: false, overrideTeb: 0x02000000 - 0xe10 + 1 },
    ] : STEPS;
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    try {
        // libv86 probes window.navigator during module evaluation even with adapters off.
        // Keep this headless import independent of other tests' partial browser mocks.
        if (!Reflect.deleteProperty(globalThis, 'window'))
            throw new Error('non-configurable window mock');
        const { V86 } = await import(LIB);
        const em = new V86({ autostart: false, memory_size: 32 << 20, wasm_path: engine, log_level: 0,
            disable_keyboard: true, disable_mouse: true, enable_speaker: false });
        const checks: Check[] = [], snaps: any[] = [], fallbacks: Array<{
            fid: number;
            index: number;
        }> = [];
        const check = (name: string, actual: unknown, want: unknown) => checks.push({ name, actual, want, pass: JSON.stringify(actual) === JSON.stringify(want) });
        let outcome: Outcome;
        try {
            await new Promise<void>(r => em.add_listener('emulator-loaded', r));
            const cpu = em.v86.cpu;
            cpu.reboot_internal();
            cpu.reset_memory();
            cpu.load_multiboot(image(steps).buffer);
            const mem = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
            const api = cpu.wm.exports, hp = api.get_hypercall_page_ptr() >>> 0, page = () => new DataView(cpu.wasm_memory.buffer, hp, 81920);
            new Uint8Array(cpu.wasm_memory.buffer, hp, 81920).fill(0);
            page().setUint32(0, 100003, true);
            page().setUint32(8, 1, true);
            page().setUint8(0x100 + GET, 64);
            page().setUint8(0x100 + SET, 86);
            page().setUint8(0xb8, 1);
            page().setUint8(0xb8 + 63, 1);
            for (let t = 0; t < 2; t++) {
                const teb = TEBS[t], implicit = layout === 'alias' ? teb + 0xe10 : IMPLICIT[t];
                mem().setUint32(teb + 0x2c, implicit, true);
                mem().setUint32(teb + 0x34, 0x7777, true);
                for (let i = 0; i < 64; i++) {
                    mem().setUint32(teb + 0xe10 + i * 4, (0x11110000 + t * 0x1000 + i) >>> 0, true);
                    if (layout === 'disjoint')
                        mem().setUint32(implicit + i * 4, (0x22220000 + t * 0x1000 + i) >>> 0, true);
                }
                mem().setUint32(teb + 0xe10 + 7 * 4, 0, true);
            }
            const implicitBefore = IMPLICIT.map(a => Array.from({ length: 64 }, (_, i) => mem().getUint32(a + i * 4, true)));
            cpu.io.register_write(PORT, null, undefined, undefined, (fid: number) => { const esp = cpu.reg32[4] >>> 0, index = cpu.read32s(esp + 4) >>> 0; fallbacks.push({ fid, index }); cpu.reg32[0] = (0xfeed0000 | index) | 0; });
            cpu.io.register_write(CTL, null, undefined, undefined, (cmd: number) => {
                const phase = cmd >>> 16, i = cmd & 65535, s = steps[i];
                if (!s)
                    throw Error('unexpected control');
                if (phase === 1) {
                    page().setUint32(0x28, s.overrideTeb ?? (s.nullTeb ? 0 : TEBS[s.thread]), true);
                    page().setUint32(0x24, 0x7777, true);
                    mem().setUint32(TEBS[s.thread] + 0x34, 0x7777, true);
                    cpu.segment_offsets[4] = TEBS[s.thread];
                }
                else if (phase === 2) {
                    const values = Array.from({ length: 6 }, (_, k) => mem().getUint32(RES + i * 32 + k * 4, true));
                    snaps.push({ i, api: s.api, index: s.index, thread: s.thread, values, lastError: page().getUint32(0x24, true), tebLastError: mem().getUint32(TEBS[s.thread] + 0x34, true) });
                }
            });
            await new Promise<void>((r, j) => { const timer = setTimeout(() => { em.stop(); j(Error('native fixture halt timeout')); }, 15000); em.bus.register('cpu-event-halt', () => { clearTimeout(timer); em.stop(); r(); }); cpu.reg32[4] = STACK; cpu.instruction_pointer[0] = ENTRY; cpu.flags[0] = 2; em.run(); });
            check('all logical calls completed', snaps.length, steps.length);
            for (const snap of snaps) {
                const s = steps[snap.i], wantError = s.served && s.api === 'get' ? 0 : 0x7777;
                check('return ' + snap.i, snap.values[0], s.want >>> 0);
                check('ABI ' + snap.i, snap.values.slice(1), [STACK, 0xb0010000 + snap.i, 0xb0020000 + snap.i, 0xb0030000 + snap.i, 0xb0040000 + snap.i]);
                check('HP LastError ' + snap.i, snap.lastError, wantError);
                check('TEB LastError ' + snap.i, snap.tebLastError, wantError);
            }
            check('declined exact route', fallbacks, steps.filter(s => !s.served).map(s => ({ fid: s.api === 'get' ? GET : SET, index: s.index })));
            const counters = { getServed: page().getUint32(0x2000 + 64 * 4, true), setServed: page().getUint32(0x2000 + 86 * 4, true), getFallbacks: page().getUint32(0x2400 + 64 * 4, true), setFallbacks: page().getUint32(0x2400 + 86 * 4, true), totalServed: page().getUint32(0xc, true) };
            check('served/fallback logical ledger', counters, guards ? { getServed: 0, setServed: 0, getFallbacks: 1, setFallbacks: 1, totalServed: 0 } : { getServed: 7, setServed: 3, getFallbacks: 3, setFallbacks: 2, totalServed: 10 });
            check('thread0 inline slots', [0, 63, 7].map(i => mem().getUint32(TEBS[0] + 0xe10 + i * 4, true)), guards ? [0x11110000, 0x1111003f, 0] : [0xbeef0000, 0xbeef003f, 0]);
            check('thread1 inline slots', [0, 63, 7].map(i => mem().getUint32(TEBS[1] + 0xe10 + i * 4, true)), guards ? [0x11111000, 0x1111103f, 0] : [0xbeef1000, 0x1111103f, 0]);
            if (layout === 'disjoint')
                for (let t = 0; t < 2; t++)
                    check('implicit untouched ' + t, Array.from({ length: 64 }, (_, i) => mem().getUint32(IMPLICIT[t] + i * 4, true)), implicitBefore[t]);
            outcome = { engine, layout, jitEnabled: true, nativeHC: true, logicalCalls: steps.length, checks, failed: checks.filter(x => !x.pass), counters, snaps, fallbacks };
        }
        catch (e) {
            outcome = { engine, layout, error: String(e), checks, failed: checks.filter(x => !x.pass) };
        }
        finally {
            await em.destroy();
        }
        return outcome;
    }
    finally {
        if (windowDescriptor)
            Object.defineProperty(globalThis, 'window', windowDescriptor);
        else
            Reflect.deleteProperty(globalThis, 'window');
    }
}
describe.skipIf(!existsSync(LIB) || !existsSync(WASM))('native TLS hypercall storage', () => {
    test('headless native fixture preserves an existing partial window descriptor', async () => {
        const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
        const partialWindow = Object.freeze({});
        expect(original?.configurable ?? true).toBe(true);
        const controlled = { value: partialWindow, writable: false, enumerable: false, configurable: true };
        Object.defineProperty(globalThis, 'window', controlled);
        try {
            const r = await runArm('alias');
            expect(r.error).toBeUndefined();
            expect(r.checks).toHaveLength(65);
            for (const c of r.checks)
                expect(c.actual, c.name).toEqual(c.want);
            expect(Object.getOwnPropertyDescriptor(globalThis, 'window')).toEqual(controlled);
        }
        finally {
            if (original)
                Object.defineProperty(globalThis, 'window', original);
            else
                Reflect.deleteProperty(globalThis, 'window');
        }
    }, 30000);
    for (const layout of ['alias', 'disjoint'] as const)
        test(layout === 'alias' ? 'existing inline/implicit alias remains compatible' : 'implicit sentinels stay distinct from dynamic slots0/63', async () => {
            const r = await runArm(layout);
            expect(r.error).toBeUndefined();
            expect(r.checks).toHaveLength(layout === 'alias' ? 65 : 67);
            for (const c of r.checks)
                expect(c.actual, c.name).toEqual(c.want);
        }, 30000);
    test('wrap and RAM-end inline addresses decline without writes or LastError changes', async () => {
        const r = await runArm('disjoint', true);
        expect(r.error).toBeUndefined();
        expect(r.checks).toHaveLength(15);
        for (const c of r.checks)
            expect(c.actual, c.name).toEqual(c.want);
    }, 30000);
});
