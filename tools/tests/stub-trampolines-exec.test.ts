// Executes the guest-side stub/trampoline emitters in real v86, with and without their
// pushfd/popfd frame, and requires the same observable result from both.
//
// thunk-stub-emitters.test.ts pins the BYTES; it cannot say what they do. Dropping the flags
// frame moves every stack argument by 4, and a single stale displacement reads the wrong
// argument while every hash still matches a deliberate re-freeze. So each stub is CALLED here:
// ring contents, fallback OUTs, refcount/owner/shadow side effects, EAX, ESP balance and the
// callee-saved registers are compared between the two modes AND checked against explicit
// expectations, so both modes cannot be wrong identically.

import { describe, it, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    writeShadowTrampoline,
    writeOwnerDisarmScalarTrampoline,
    writeStructCaptureTrampoline,
    writeMultiStructCaptureTrampoline,
    writeUpDrawCaptureTrampoline,
    writeIncRefStubTrampoline,
    writeDecRefStubTrampoline,
} from '../../src/worker/modules/d3d9/capture-trampolines';
import { ThunkMemoryManager, type StubAllocator } from '../../src/worker/core/thunking/thunk-memory-manager';

const LIB = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const WASM = fileURLToPath(new URL('../../vendor/v86/build/v86.wasm', import.meta.url));
const HAVE_V86 = existsSync(LIB) && existsSync(WASM);

const BASE = 0x100000, IMG = 0x40000;
const STUBS = BASE + 0x10000;
const RES = BASE + 0x20000;          // per-call records
const OWNER = BASE + 0x2f000, EXPECT_VT = BASE + 0x2f010, OBJ = BASE + 0x2f100;
const VTABLE = 0x7e0000, FOREIGN_VT = 0x7e1000;
const PAYLOAD = BASE + 0x2f200, VERTS = BASE + 0x2e000;
const CTRL = BASE + 0x30000, RING = BASE + 0x30100, CAPACITY = 0x4000;
const DEV = 0x5fb00130, OTHER = 0x5fb00999, FID = 0x1234;
const REC = 24;
const SENTINELS = [0x11111111, 0x22222222, 0x33333333, 0x44444444]; // ebx, esi, edi, ebp

interface Call { stub: string; args: number[]; fid?: number; ringHead?: number }

function buildImage(preserve: boolean): { bytes: Uint8Array; calls: Call[]; stubs: Record<string, number> } {
    const g = globalThis as { __stubsPreserveEflags?: boolean };
    const prev = g.__stubsPreserveEflags;
    g.__stubsPreserveEflags = preserve;
    try {
        const mem = new Uint8Array(BASE + IMG);
        const dv = new DataView(mem.buffer);
        let bump = STUBS;
        const allocator: StubAllocator = { alloc(size: number): number { const a = bump; bump = (bump + size + 15) & ~15; return a; } };
        const getMemory = () => mem;
        const stubs: Record<string, number> = {};

        stubs.renderState = writeShadowTrampoline(allocator, getMemory, CTRL, RING, CAPACITY, OWNER,
            { argCount: 3, valueArgIndex: 2, slotCount: 256, keyParts: [{ argIndex: 1, shift: 0, max: 256 }] }).trampAddr;
        stubs.sampler = writeShadowTrampoline(allocator, getMemory, CTRL, RING, CAPACITY, OWNER,
            { argCount: 4, valueArgIndex: 3, slotCount: 256, keyParts: [{ argIndex: 1, shift: 4, max: 16 }, { argIndex: 2, shift: 0, max: 16 }] }).trampAddr;
        stubs.addRef = writeIncRefStubTrampoline(allocator, getMemory, { fieldOffset: 4, popBytes: 4, expectVtableAddr: EXPECT_VT }).trampAddr;
        stubs.release = writeDecRefStubTrampoline(allocator, getMemory, { fieldOffset: 4, popBytes: 4, expectVtableAddr: EXPECT_VT }).trampAddr;
        stubs.disarm = writeOwnerDisarmScalarTrampoline(allocator, getMemory, CTRL, RING, CAPACITY, 2, OWNER).trampAddr;
        stubs.struct = writeStructCaptureTrampoline(allocator, getMemory, CTRL, RING, CAPACITY,
            { argCount: 3, ptrArgIndex: 2, payloadDwords: 4 }).trampAddr;
        stubs.multi = writeMultiStructCaptureTrampoline(allocator, getMemory, CTRL, RING, CAPACITY,
            { argCount: 3, ptrArgIndices: [0, 2], payloadDwords: 2 }).trampAddr;
        stubs.upDraw = writeUpDrawCaptureTrampoline(allocator, getMemory, CTRL, RING, CAPACITY).trampAddr;
        const wbuf = (ThunkMemoryManager.prototype as unknown as {
            writeWriteBufTrampolines(m: Uint8Array, base: number, ctrl: number, data: number, cap: number): number[];
        }).writeWriteBufTrampolines.call({}, mem, allocator.alloc(0x1000), CTRL, RING, CAPACITY);
        stubs.wbuf3 = wbuf[(3 - 1) * 2];     // 3 args, stdcall
        stubs.ptr3f = wbuf[16];               // PtrDeref3F, stdcall
        stubs.shaderConst = wbuf[20];

        // Guest state the stubs consult.
        dv.setUint32(OWNER, DEV, true);
        dv.setUint32(EXPECT_VT, VTABLE, true);
        dv.setUint32(OBJ, VTABLE, true); dv.setUint32(OBJ + 4, 5, true);
        dv.setUint32(OBJ + 0x40, FOREIGN_VT, true); dv.setUint32(OBJ + 0x44, 9, true);
        dv.setUint32(OBJ + 0x80, VTABLE, true); dv.setUint32(OBJ + 0x84, 1, true);
        for (let i = 0; i < 16; i++) dv.setUint32(PAYLOAD + i * 4, 0xa0000000 + i, true);
        for (let i = 0; i < 64; i++) dv.setUint32(VERTS + i * 4, 0xb0000000 + i, true);

        const calls: Call[] = [
            { stub: 'renderState', args: [DEV, 5, 7] },          // first set -> ring
            { stub: 'renderState', args: [DEV, 5, 7] },          // shadow hit -> skip
            { stub: 'renderState', args: [DEV, 5, 9] },          // changed -> ring
            { stub: 'renderState', args: [OTHER, 5, 9] },        // owner mismatch -> ring
            { stub: 'renderState', args: [DEV, 300, 1] },        // key out of range -> ring
            { stub: 'sampler', args: [DEV, 2, 3, 0x55] },        // ring
            { stub: 'sampler', args: [DEV, 2, 3, 0x55] },        // skip
            { stub: 'sampler', args: [DEV, 2, 16, 0x55] },       // 2nd key out of range -> ring
            { stub: 'addRef', args: [OBJ] },                     // 5 -> 6
            { stub: 'addRef', args: [0] },                       // null -> OUT
            { stub: 'addRef', args: [OBJ + 0x40] },              // foreign vtable -> OUT
            { stub: 'release', args: [OBJ] },                    // 6 -> 5
            { stub: 'release', args: [OBJ + 0x80] },             // 1 -> OUT, untouched
            { stub: 'disarm', args: [0x77, 0x88] },              // ring + owner := 0
            { stub: 'renderState', args: [DEV, 5, 9] },          // owner disarmed -> ring
            { stub: 'struct', args: [DEV, 7, PAYLOAD] },         // ring + 4 payload dwords
            { stub: 'struct', args: [DEV, 7, 0] },               // null ptr -> OUT
            { stub: 'multi', args: [PAYLOAD, 0x99, PAYLOAD + 16] },
            { stub: 'upDraw', args: [DEV, 4, 2, VERTS, 16] },    // triangle list: 6 verts x 16B
            { stub: 'upDraw', args: [DEV, 4, 2, VERTS, 6] },     // unaligned stride -> OUT
            { stub: 'wbuf3', args: [1, 2, 3] },
            { stub: 'ptr3f', args: [PAYLOAD] },
            { stub: 'shaderConst', args: [DEV, 4, PAYLOAD, 2] },
            { stub: 'wbuf3', args: [4, 5, 6], ringHead: CAPACITY - 8 },   // ring full -> OUT
        ];

        // Driver: per call, seed callee-saved sentinels, push args, call, record the state.
        let p = BASE + 0x40;
        const e = (...b: number[]) => { for (const x of b) mem[p++] = x & 0xff; };
        const u = (v: number) => { dv.setUint32(p, v >>> 0, true); p += 4; };
        e(0xbc); u(0x200000);                                    // mov esp
        const SAVED_HEAD = RES - 4;
        calls.forEach((c, k) => {
            if (c.ringHead !== undefined) {
                e(0xa1); u(CTRL); e(0xa3); u(SAVED_HEAD);         // keep the real head
                e(0xc7, 0x05); u(CTRL); u(c.ringHead);
            }
            e(0xbb); u(SENTINELS[0]); e(0xbe); u(SENTINELS[1]); e(0xbf); u(SENTINELS[2]); e(0xbd); u(SENTINELS[3]);
            for (let i = c.args.length - 1; i >= 0; i--) { e(0x68); u(c.args[i]); }
            e(0xb8); u(c.fid ?? FID + k);                        // mov eax, funcId
            e(0xe8); u(stubs[c.stub] - (p + 4));                 // call stub
            const r = RES + k * REC;
            e(0xa3); u(r);                                       // mov [r], eax
            e(0x89, 0x1d); u(r + 4); e(0x89, 0x35); u(r + 8);    // ebx, esi
            e(0x89, 0x3d); u(r + 12); e(0x89, 0x2d); u(r + 16);  // edi, ebp
            e(0x89, 0x25); u(r + 20);                            // esp
            if (c.ringHead !== undefined) { e(0xa1); u(SAVED_HEAD); e(0xa3); u(CTRL); }
        });
        e(0xf4);

        const bytes = mem.slice(BASE, BASE + IMG);
        const hd = new DataView(bytes.buffer);
        [0x1badb002, 0x10000, (-0x1badb002 - 0x10000) >>> 0, BASE, BASE, BASE + IMG, BASE + IMG, BASE + 0x40]
            .forEach((v, i) => hd.setUint32(i * 4, v, true));
        return { bytes, calls, stubs };
    } finally {
        g.__stubsPreserveEflags = prev;
    }
}

interface Run { records: number[][]; outs: number[]; ring: number[]; head: number; obj: number[]; owner: number; mem: DataView }

/** libv86 treats a defined `window` as a browser (navigator probe at load, key listeners in
 *  its constructor/destroy); a partial DOM shim another test left on globalThis breaks both,
 *  so the emulator's whole lifetime runs with it hidden. */
async function withoutWindow<T>(fn: () => Promise<T>): Promise<T> {
    const g = globalThis as { window?: unknown };
    const had = 'window' in g;
    const saved = g.window;
    if (had) delete g.window;
    try {
        return await fn();
    } finally {
        if (had) g.window = saved;
    }
}

function run(bytes: Uint8Array, nCalls: number): Promise<Run> {
    return withoutWindow(() => runInV86(bytes, nCalls));
}

async function runInV86(bytes: Uint8Array, nCalls: number): Promise<Run> {
    const { V86 } = await import(LIB);
    const em = new V86({ autostart: false, memory_size: 16 << 20, wasm_path: WASM, log_level: 0, disable_jit: 1 });
    await new Promise<void>(r => em.add_listener('emulator-loaded', r));
    const c = em.v86.cpu;
    c.reboot_internal(); c.reset_memory(); c.load_multiboot(bytes.buffer);
    const outs: number[] = [];
    c.io.register_write(0xb077, c, undefined, undefined, (v: number) => { outs.push(v >>> 0); });
    await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => { em.stop(); reject(new Error('guest did not halt')); }, 15000);
        em.bus.register('cpu-event-halt', () => { clearTimeout(t); em.stop(); resolve(); });
        em.run();
    });
    const r32 = (a: number) => c.read32s(a) >>> 0;
    const records = Array.from({ length: nCalls }, (_, k) => Array.from({ length: 6 }, (_, i) => r32(RES + k * REC + i * 4)));
    const head = r32(CTRL);
    const ring = Array.from({ length: head / 4 }, (_, i) => r32(RING + i * 4));
    const obj = [r32(OBJ + 4), r32(OBJ + 0x44), r32(OBJ + 0x84)];
    const out = { records, outs, ring, head, obj, owner: r32(OWNER), mem: new DataView(new ArrayBuffer(0)) };
    await em.destroy();            // async: its adapter teardown must also run while window is hidden
    await new Promise(r => setTimeout(r, 0));
    return out;
}

describe.skipIf(!HAVE_V86)('guest stub trampolines, executed', () => {
    it('behave identically with and without the pushfd/popfd frame', async () => {
        const lean = buildImage(false), saving = buildImage(true);
        const a = await run(lean.bytes, lean.calls.length);
        const b = await run(saving.bytes, saving.calls.length);

        // Every call returns with ESP balanced and every callee-saved register intact.
        for (const [k, rec] of a.records.entries()) {
            expect(`#${k} ${lean.calls[k].stub} ebx/esi/edi/ebp/esp ${rec.slice(1).map(v => v.toString(16))}`)
                .toBe(`#${k} ${lean.calls[k].stub} ebx/esi/edi/ebp/esp ${[...SENTINELS, 0x200000].map(v => v.toString(16))}`);
        }
        expect(a).toEqual(b);

        // Absolute expectations, so identical-but-wrong cannot pass.
        const fid = (k: number) => FID + k;
        const eax = (k: number) => a.records[k][0];
        expect(eax(0)).toBe(0); expect(eax(1)).toBe(0);
        expect(eax(8)).toBe(6);                                   // AddRef answered in guest
        expect(eax(11)).toBe(5);                                  // Release answered in guest
        expect(a.obj).toEqual([5, 9, 1]);                         // 5->6->5; foreign & 1->0 untouched
        expect(a.owner).toBe(0);                                  // disarmed
        expect(a.outs).toEqual([fid(9), fid(10), fid(12), fid(16), fid(19), fid(23)]);
        const ring = a.ring;
        const expected = [
            fid(0), DEV, 5, 7,
            fid(2), DEV, 5, 9,
            fid(3), OTHER, 5, 9,
            fid(4), DEV, 300, 1,
            fid(5), DEV, 2, 3, 0x55,
            fid(7), DEV, 2, 16, 0x55,
            fid(13), 0x77, 0x88,
            fid(14), DEV, 5, 9,
            fid(15), DEV, 7, PAYLOAD, 0xa0000000, 0xa0000001, 0xa0000002, 0xa0000003,
            fid(17), PAYLOAD, 0x99, PAYLOAD + 16, 0xa0000000, 0xa0000001, 0xa0000004, 0xa0000005,
            fid(18), DEV, 4, 2, 16, 96, ...Array.from({ length: 24 }, (_, i) => 0xb0000000 + i),
            fid(20), 1, 2, 3,
            fid(21), 0xa0000000, 0xa0000001, 0xa0000002,
            fid(22), DEV, 4, 2, ...Array.from({ length: 8 }, (_, i) => 0xa0000000 + i),
        ];
        expect(ring.map(v => v.toString(16))).toEqual(expected.map(v => (v >>> 0).toString(16)));
    }, 60_000);
});
