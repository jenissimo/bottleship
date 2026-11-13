// Executed Wasm-op density: the block map v86 records per published module (jit_block_map.rs),
// captured by the harness publication journal, joined with trace2 exec counts.
//
// Synthetic module: exact numbers, and the controls that make them mean something (swapped
// counts move the answer, a map that is not this module's or that cuts an instruction is
// refused, a same-address block with another instruction count is not joined, a traced copy
// loses to an untraced one).
//
// Real v86: a hot 42-instruction integer loop and a cold x87 block run once, both on one page.
// The executed density must be the hot block's own ops/instruction, the unweighted static
// density over the same blocks must not be (the cold x87 block drags it up), and every
// counted instruction must be matched.

import { describe, it, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJitPublicationCapture, readJitBlockMap, moduleBodyLength } from '../../src/worker/harness/jit-publications';
import { execDensity, blockOps } from '../bench-v86/jit-exec-density.mjs';

const LIB = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const WASM = fileURLToPath(new URL('../../vendor/v86/build/v86.wasm', import.meta.url));
const HAVE_V86 = existsSync(LIB) && existsSync(WASM);

/** Single-function module around `body` (no locals); the final `end` is appended. */
function moduleOf(body: number[]): Uint8Array {
    const fn = [0x00, ...body, 0x0b];
    const code = [0x01, fn.length, ...fn];
    return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
        0x03, 0x02, 0x01, 0x00,
        0x0a, code.length, ...code]);
}

// A: i32.const 1; drop                       body [0,3)   2 ops, 1 guest instruction
// -: nop                                     body [3,4)   dispatcher stand-in, no block
// B: i32.const 1; i32.const 2; i32.add; drop body [4,10)  4 ops, 4 guest instructions
const BODY = [0x41, 0x01, 0x1a, 0x01, 0x41, 0x01, 0x41, 0x02, 0x6a, 0x1a];
const A = 0x401000, B = 0x401010;
const block = (addr: number, instructions: number, bodyStart: number, bodyEnd: number, traced = false) => ({
    addr, virtAddr: addr, endAddr: addr + 4, lastInstructionAddr: addr, instructions, bodyStart, bodyEnd, entry: false, traced });

async function journal(mods: Array<{ bytes: Uint8Array; blocks: ReturnType<typeof block>[]; bodyLength?: number }>) {
    const queue = [...mods];
    let current: (typeof mods)[number] | undefined;
    const capture = createJitPublicationCapture({}, () => current ? { bodyLength: current.bodyLength ?? 10, blocks: current.blocks } : null);
    for (const m of queue) {
        current = m;
        capture.begin(0x401000, 1, 1025, m.bytes)!.published();
    }
    capture.seal();
    return capture.export();
}
const rows = (a: number, b: number, insA = 1, insB = 4) => [
    { addr: '0x' + A.toString(16), exec: a, ins: insA, module: 'game.exe+0x1000' },
    { addr: '0x' + B.toString(16), exec: b, ins: insB, module: 'game.exe+0x1010' },
];

describe('executed density join (synthetic module)', () => {
    it('weights static ops by exec counts', async () => {
        const pubs = await journal([{ bytes: moduleOf(BODY), blocks: [block(A, 1, 0, 3), block(B, 4, 4, 10)] }]);
        expect(pubs.events[0].blockMap.status).toBe('ok');
        const r = execDensity(pubs, { counted: { available: true, rows: rows(100, 10) } });
        // (100*2 + 10*4) / (100*1 + 10*4) = 240/140
        expect(r.total.executedOps).toBe(240);
        expect(r.total.executedIns).toBe(140);
        expect(r.total.executedDensity).toBe(1.714);
        expect(r.total.staticDensity).toBe(1.2);           // (2+4)/(1+4), unweighted
        expect(r.coverage.matchedPct).toBe(100);
        expect(r.byJitModule[0].unattributedOps).toBe(2);    // the nop and the final end
        expect(r.byGuestModule.map((g: any) => g.name)).toEqual(['game.exe']);
        const ranged = execDensity(pubs, rows(100, 10), { ranges: [{ name: 'f', from: '0x401010', to: '0x401020' }] });
        expect(ranged.byRange[0]).toMatchObject({ name: 'f', executedOps: 40, executedIns: 40, executedDensity: 1 });
    });

    it('negative control: swapping the counts moves the answer', async () => {
        const pubs = await journal([{ bytes: moduleOf(BODY), blocks: [block(A, 1, 0, 3), block(B, 4, 4, 10)] }]);
        // (10*2 + 100*4) / (10*1 + 100*4) = 420/410
        expect(execDensity(pubs, rows(10, 100)).total.executedDensity).toBe(1.024);
    });

    it('refuses a map that is not this module, or cuts an instruction', async () => {
        const bytes = moduleOf(BODY);
        expect(moduleBodyLength(bytes)).toBe(10);
        const wrongLen = await journal([{ bytes, blocks: [block(A, 1, 0, 3)], bodyLength: 9 }]);
        expect(wrongLen.events[0].blockMap.status).toBe('mismatch');
        const r = execDensity(wrongLen, rows(100, 10));
        expect(r.coverage.matchedPct).toBe(0);
        expect(r.coverage.unmapped.execIns).toBe(140);
        expect(() => blockOps(bytes, { bodyLength: 10, blocks: [block(A, 1, 1, 3)] })).toThrow('instruction boundaries');
        expect(() => blockOps(bytes, { bodyLength: 9, blocks: [block(A, 1, 0, 3)] })).toThrow('body length');
    });

    it('does not join a same-address block of another shape', async () => {
        const pubs = await journal([{ bytes: moduleOf(BODY), blocks: [block(A, 1, 0, 3), block(B, 4, 4, 10)] }]);
        const r = execDensity(pubs, rows(100, 10, 3));
        expect(r.coverage.shapeMismatch).toEqual({ blocks: 1, execIns: 300 });
        expect(r.total.executedIns).toBe(40);
    });

    it('prefers an untraced copy over a later traced one, and reports the spread', async () => {
        const traced = [0x41, 0x01, 0x1a, 0x01, 0x01, 0x01, 0x41, 0x01, 0x41, 0x02, 0x6a, 0x1a];   // A grows by 3 nops
        const pubs = await journal([
            { bytes: moduleOf(BODY), blocks: [block(A, 1, 0, 3), block(B, 4, 4, 10)] },
            { bytes: moduleOf(traced), blocks: [block(A, 1, 0, 6, true), block(B, 4, 6, 12, true)], bodyLength: 12 },
        ]);
        const r = execDensity(pubs, rows(100, 10));
        expect(r.total.executedDensity).toBe(1.714);
        expect(r.coverage.tracedOnlyIns).toBe(0);
        const onlyTraced = await journal([
            { bytes: moduleOf(traced), blocks: [block(A, 1, 0, 6, true), block(B, 4, 6, 12, true)], bodyLength: 12 },
        ]);
        const t = execDensity(onlyTraced, rows(100, 10));
        expect(t.coverage.tracedOnlyIns).toBe(140);
        expect(t.total.executedOps).toBe(100 * 5 + 10 * 4);
    });
});

// ── real v86 ──────────────────────────────────────────────────────────────

const BASE = 0x100000, ENTRY_OFF = 0x40, HOT_LEN = 40, COLD_PAIRS = 12, ITER = 200000;

function image() {
    const buf = new Uint8Array(0x1000);
    const dv = new DataView(buf.buffer);
    [0x1badb002, 0x10000, (-0x1badb002 - 0x10000) >>> 0, BASE, BASE, BASE + buf.length, BASE + 0x4000, BASE + ENTRY_OFF]
        .forEach((v, i) => dv.setUint32(i * 4, v, true));
    let o = ENTRY_OFF;
    const e = (...b: number[]) => { for (const x of b) buf[o++] = x; };
    const u = (v: number) => { dv.setUint32(o, v >>> 0, true); o += 4; };
    e(0xb9); u(ITER);                                       // mov ecx, ITER
    e(0xbb); u(1);                                          // mov ebx, 1
    const hot = o;
    for (let i = 0; i < HOT_LEN; i++) e(0x01, 0xd8);        // add eax, ebx
    e(0x49);                                                // dec ecx
    e(0x0f, 0x85); u(hot - (o + 4));                        // jnz hot
    const cold = o;
    for (let i = 0; i < COLD_PAIRS; i++) e(0xd9, 0xe8, 0xdd, 0xd8);  // fld1; fstp st0
    e(0xf4, 0xeb, 0xfe);                                    // hlt; jmp $
    return { buf, hot: BASE + hot, cold: BASE + cold };
}

async function withoutWindow<T>(fn: () => Promise<T>): Promise<T> {
    const g = globalThis as { window?: unknown };
    const had = 'window' in g, saved = g.window;
    if (had) delete g.window;
    try { return await fn(); } finally { if (had) g.window = saved; }
}

/** One guest run. `map`: capture publications with block maps; `count`: trace2 census rows. */
async function runGuest({ map, count }: { map: boolean; count: boolean }) {
    const { V86 } = await import(LIB);
    const { SHIPPING_JIT, applyCodegenSwitches } = await import('../jit-config/shipping.mjs');
    const em = new V86({ autostart: false, memory_size: 16 << 20, wasm_path: WASM, log_level: 0 });
    await new Promise<void>(r => em.add_listener('emulator-loaded', r));
    const c = em.v86.cpu, w = c.wm.exports;
    const g = globalThis as { __jitPublicationCapture?: unknown };
    const { buf } = image();
    c.reboot_internal(); c.reset_memory(); c.load_multiboot(buf.buffer);
    for (const [i, v] of SHIPPING_JIT as Array<[number, number]>) w.set_jit_config(i, v);
    applyCodegenSwitches(w);
    const capture = map ? createJitPublicationCapture({}, () => readJitBlockMap(w, c.wasm_memory.buffer)) : null;
    if (map) { w.jit_block_map_set_enabled(1); g.__jitPublicationCapture = capture; }
    if (count) w.trace2_watch_page(BASE);
    try {
        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => { em.stop(); reject(new Error('guest did not halt')); }, 60000);
            em.bus.register('cpu-event-halt', () => { clearTimeout(t); em.stop(); resolve(); });
            em.run();
        });
        // Let in-flight instantiations publish before sealing.
        await new Promise(r => setTimeout(r, 50));
        let counted: Array<{ addr: string; exec: number; ins: number }> = [];
        if (count) {
            const n = w.trace2_block_snapshot() >>> 0;
            for (let i = 0; i < n; i++) {
                counted.push({ addr: '0x' + (w.trace2_block_addr(i) >>> 0).toString(16),
                    exec: w.trace2_block_exec(i) >>> 0, ins: w.trace2_block_instructions(i) >>> 0 });
            }
        }
        capture?.seal();
        return { publications: capture ? await capture.export() : null, counted, ecx: c.reg32[1] >>> 0 };
    } finally {
        delete g.__jitPublicationCapture;
        await em.destroy();
        await new Promise(r => setTimeout(r, 0));
    }
}

describe.skipIf(!HAVE_V86)('executed density in v86', () => {
    it('is the hot block\'s density, not the static average', async () => {
        const { hot, cold } = image();
        const mapped = await withoutWindow(() => runGuest({ map: true, count: false }));
        const census = await withoutWindow(() => runGuest({ map: false, count: true }));
        expect(mapped.ecx).toBe(0);
        expect(census.ecx).toBe(0);
        const pubs = mapped.publications!;
        expect(pubs.guestInstructionMap.status).toBe('blocks');
        const ours = pubs.events.filter((e: any) => e.status === 'published' && e.blockMap?.status === 'ok');
        expect(ours.length).toBeGreaterThan(0);
        expect(ours.every((e: any) => e.blockMap.blocks.every((b: any) => !b.traced))).toBe(true);

        const r = execDensity(pubs, census.counted, { top: 10 });
        const row = (a: number) => r.topBlocks.find((b: any) => b.addr === '0x' + a.toString(16));
        const h = row(hot), k = row(cold);
        expect(h?.ins).toBe(HOT_LEN + 2);
        expect(k?.ins).toBe(2 * COLD_PAIRS + 1);
        expect(h!.exec).toBeGreaterThan(ITER * 0.9);
        expect(h!.exec).toBeLessThanOrEqual(ITER);
        expect(k!.exec).toBe(1);
        expect(r.coverage.matchedPct).toBe(100);
        // Executed = the hot loop; the cold x87 block runs once and cannot move it.
        expect(Math.abs(r.total.executedDensity - h!.opsPerIns) / h!.opsPerIns).toBeLessThan(0.01);
        // Negative control: the static, unweighted average over the same blocks is NOT that.
        expect(k!.opsPerIns).toBeGreaterThan(h!.opsPerIns);
        expect(r.total.staticDensity).toBeGreaterThan(r.total.executedDensity * 1.05);
        console.log('jit-exec-density', JSON.stringify({ total: r.total, hot: h, cold: k }));
    }, 120000);
});
