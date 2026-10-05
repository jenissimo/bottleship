// The static-CRT _ftol/_ftol2 bodies are replaced in place by FISTTP (native-leaves.ts). The
// replacement is guest code the JIT compiles, so nothing at runtime re-checks it against the
// original. Here both ORIGINAL bodies (the exact bytes MSVC6 and MSVC7.1 link into a game) and
// the copies applyNativeLeaves rewrote are called in real v86 over the same inputs, under every
// rounding mode and both precision controls, interpreted and JIT-compiled, relaxed and exact
// x87 — and each must equal an absolute truncation oracle, so original and replacement cannot
// agree on a wrong answer.

import { describe, it, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyNativeLeaves, NATIVE_LEAVES } from '../../src/worker/core/hle-lib/native-leaves';
import type { LoadedPEModule } from '../../src/worker/core/module-registry';

const LIB = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const WASM = fileURLToPath(new URL('../../vendor/v86/build/v86.wasm', import.meta.url));
const HAVE_V86 = existsSync(LIB) && existsSync(WASM);

const BASE = 0x100000, IMG = 0x40000;
const ORIG_VC6 = BASE + 0x1000, ORIG_VC71 = BASE + 0x1100;
const TEXT = BASE + 0x2000, COPY_VC6 = TEXT, COPY_VC71 = TEXT + 0x100, TEXT_SIZE = 0x200;
const INPUTS = BASE + 0x3000, CWTAB = BASE + 0x3800, FNTAB = BASE + 0x3840, CWI = BASE + 0x3860;
const RES = BASE + 0x4000, REC = 16;
const STACK = BASE + 0x3f000;

const leaf = (name: string) => NATIVE_LEAVES.find(l => l.name === name)!.body;
const FNS = [ORIG_VC6, ORIG_VC71, COPY_VC6, COPY_VC71];

const INPUT_VALUES = [
    0, -0, 0.25, 0.5, 0.75, 1, 1.5, 2.5, -0.25, -0.5, -0.75, -1, -1.5, -2.5,
    0.49999999999999994, 0.9999999999999999, -0.9999999999999999,
    1234.75, -77.25, 2147483647.5, 2147483648.5, -2147483648.5, -2147483649.5,
    4294967295.75, 4294967296.25, -4294967296.25, 2 ** 52 - 0.5, -(2 ** 52) + 0.5,
    2 ** 53, -(2 ** 53), 2 ** 62 + 2 ** 40, -(2 ** 63), 2 ** 63, 9.3e18, -9.3e18,
    1e300, -1e300, Infinity, -Infinity, NaN, 5e-324, -5e-324, -1e-300,
];
// RC (bits 11:10) x PC (bits 9:8), all exceptions masked.
const CONTROL_WORDS = [0, 1, 2, 3].flatMap(rc => [3, 0].map(pc => 0x7f | (pc << 8) | (rc << 10)));

function oracle(x: number): bigint {
    const t = Math.trunc(x);
    return Number.isNaN(t) || t >= 2 ** 63 || t < -(2 ** 63) ? -(2n ** 63n) : BigInt(t);
}

function buildImage(repeat: number): { bytes: Uint8Array; sites: ReturnType<typeof applyNativeLeaves> } {
    const mem = new Uint8Array(BASE + IMG);
    const dv = new DataView(mem.buffer);
    [0x1badb002, 0x10000, (-0x1badb002 - 0x10000) >>> 0, BASE, BASE, BASE + IMG, BASE + IMG, BASE + 0x40]
        .forEach((v, i) => dv.setUint32(BASE + i * 4, v, true));
    mem.set(leaf('_ftol'), ORIG_VC6); mem.set(leaf('_ftol2'), ORIG_VC71);
    mem.set(leaf('_ftol'), COPY_VC6); mem.set(leaf('_ftol2'), COPY_VC71);
    INPUT_VALUES.forEach((v, i) => dv.setFloat64(INPUTS + i * 8, v, true));
    CONTROL_WORDS.forEach((v, i) => dv.setUint16(CWTAB + i * 2, v, true));
    FNS.forEach((v, i) => dv.setUint32(FNTAB + i * 4, v, true));

    const module = {
        name: 'fixture.exe', baseAddress: TEXT, size: TEXT_SIZE,
        sections: [{ name: '.text', virtualAddress: 0, virtualSize: TEXT_SIZE, rawSize: TEXT_SIZE, characteristics: 0x60000020 }],
    } as unknown as LoadedPEModule;
    const sites = applyNativeLeaves(mem, module);

    let p = BASE + 0x40;
    const e = (...b: number[]) => { mem.set(b, p); p += b.length; };
    const u = (v: number) => { dv.setUint32(p, v >>> 0, true); p += 4; };
    const rel = (target: number) => { u(target - (p + 4)); };
    e(0xbc); u(STACK);                                  // mov esp, STACK
    e(0xdb, 0xe3);                                      // fninit
    e(0xbd); u(repeat);                                 // mov ebp, repeat
    const outer = p;
    e(0xc7, 0x05); u(CWI); u(0);                        // mov dword [CWI], 0
    const cwLoop = p;
    e(0xa1); u(CWI);                                    // mov eax, [CWI]
    e(0xd9, 0x2c, 0x45); u(CWTAB);                      // fldcw [CWTAB + eax*2]
    e(0x31, 0xf6);                                      // xor esi, esi
    const fnLoop = p;
    e(0x31, 0xff);                                      // xor edi, edi
    const inLoop = p;
    e(0xdd, 0x04, 0xfd); u(INPUTS);                     // fld qword [INPUTS + edi*8]
    e(0xff, 0x14, 0xb5); u(FNTAB);                      // call [FNTAB + esi*4]
    e(0x8b, 0x0d); u(CWI);                              // mov ecx, [CWI]
    e(0x6b, 0xc9, FNS.length);                          // imul ecx, ecx, nFns
    e(0x01, 0xf1);                                      // add ecx, esi
    e(0x6b, 0xc9, INPUT_VALUES.length);                 // imul ecx, ecx, nInputs
    e(0x01, 0xf9);                                      // add ecx, edi
    e(0xc1, 0xe1, 0x04);                                // shl ecx, 4
    e(0x89, 0x81); u(RES);                              // mov [ecx+RES], eax
    e(0x89, 0x91); u(RES + 4);                          // mov [ecx+RES+4], edx
    e(0x89, 0xa1); u(RES + 8);                          // mov [ecx+RES+8], esp
    e(0xdf, 0xe0);                                      // fnstsw ax
    e(0x25); u(0x3800);                                 // and eax, TOP
    e(0x89, 0x81); u(RES + 12);                         // mov [ecx+RES+12], eax
    e(0x47);                                            // inc edi
    e(0x83, 0xff, INPUT_VALUES.length);                 // cmp edi, nInputs
    e(0x0f, 0x82); rel(inLoop);                         // jb inLoop
    e(0x46);                                            // inc esi
    e(0x83, 0xfe, FNS.length);                          // cmp esi, nFns
    e(0x0f, 0x82); rel(fnLoop);                         // jb fnLoop
    e(0xff, 0x05); u(CWI);                              // inc dword [CWI]
    e(0x83, 0x3d); u(CWI); e(CONTROL_WORDS.length);     // cmp dword [CWI], nCws
    e(0x0f, 0x82); rel(cwLoop);                         // jb cwLoop
    e(0x4d);                                            // dec ebp
    e(0x0f, 0x85); rel(outer);                          // jnz outer
    e(0xf4);                                            // hlt
    return { bytes: mem.slice(BASE), sites };
}

/** libv86 treats a defined `window` as a browser; a DOM shim another test left on globalThis
 *  breaks its load and teardown, so the emulator's whole lifetime runs with it hidden. */
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

interface Arm { jit: boolean; relaxed: boolean }

async function runArm(arm: Arm, bytes: Uint8Array): Promise<{ rec: DataView; jitTruncates: boolean }> {
    const { V86 } = await import(LIB);
    const { SHIPPING_JIT, applyCodegenSwitches } = await import('../jit-config/shipping.mjs');
    const em = new V86({ autostart: false, memory_size: 16 << 20, wasm_path: WASM, log_level: 0, ...(arm.jit ? {} : { disable_jit: 1 }) });
    await new Promise<void>(r => em.add_listener('emulator-loaded', r));
    const c = em.v86.cpu, w = c.wm.exports;
    c.reboot_internal(); c.reset_memory(); c.load_multiboot(bytes.buffer);
    if (arm.jit) {
        for (const [i, v] of SHIPPING_JIT as Array<[number, number]>) w.set_jit_config(i, v);
        applyCodegenSwitches(w);
    }
    w.set_relaxed_fpu(arm.relaxed ? 1 : 0);
    const g = globalThis as { __wasmDump?: { out: Array<{ bytes: Uint8Array }> } };
    g.__wasmDump = { out: [] };
    try {
        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => { em.stop(); reject(new Error('guest did not halt')); }, 60000);
            em.bus.register('cpu-event-halt', () => { clearTimeout(t); em.stop(); resolve(); });
            em.run();
        });
        const n = CONTROL_WORDS.length * FNS.length * INPUT_VALUES.length * REC;
        const rec = new DataView(new ArrayBuffer(n));
        for (let i = 0; i < n; i += 4) rec.setUint32(i, c.read32s(RES + i) >>> 0, true);
        const jitTruncates = g.__wasmDump.out.some(r =>
            WebAssembly.Module.imports(new WebAssembly.Module(r.bytes)).some(x => x.name === 'fpu_truncate_to_i64'));
        return { rec, jitTruncates };
    } finally {
        delete g.__wasmDump;
        await em.destroy();
        await new Promise(r => setTimeout(r, 0));
    }
}

function mismatches(rec: DataView): string[] {
    const bad: string[] = [];
    CONTROL_WORDS.forEach((cw, ci) => FNS.forEach((_, fi) => INPUT_VALUES.forEach((x, ii) => {
        const o = ((ci * FNS.length + fi) * INPUT_VALUES.length + ii) * REC;
        const got = rec.getBigInt64(o, true);
        const esp = rec.getUint32(o + 8, true), top = rec.getUint32(o + 12, true);
        const want = oracle(x);
        if (got !== want || esp !== STACK || top !== 0) {
            bad.push(`cw=0x${cw.toString(16)} fn=${['vc6', 'vc71', 'vc6-native', 'vc71-native'][fi]} x=${x}: `
                + `got ${got} want ${want} esp=0x${esp.toString(16)} top=${top >> 11}`);
        }
    })));
    return bad;
}

describe('static CRT _ftol leaves', () => {
    it('are found by their whole body and rewritten in place, originals elsewhere untouched', () => {
        const { bytes, sites } = buildImage(1);
        expect(sites.map(s => `${s.crt}:${s.name}@0x${s.address.toString(16)}`))
            .toEqual([`msvc6:_ftol@0x${COPY_VC6.toString(16)}`, `msvc7.1:_ftol2@0x${COPY_VC71.toString(16)}`]);
        const at = (a: number, n: number) => Array.from(bytes.subarray(a - BASE, a - BASE + n));
        expect(at(ORIG_VC6, leaf('_ftol').length)).toEqual(Array.from(leaf('_ftol')));
        expect(at(ORIG_VC71, leaf('_ftol2').length)).toEqual(Array.from(leaf('_ftol2')));
        expect(at(COPY_VC6, 9)).toEqual([0x83, 0xec, 0x08, 0xdd, 0x0c, 0x24, 0x58, 0x5a, 0xc3]);
        expect(at(COPY_VC71, 9)).toEqual([0x83, 0xec, 0x08, 0xdd, 0x0c, 0x24, 0x58, 0x5a, 0xc3]);
    });

    it('a body that differs by one byte is not a match', () => {
        const mem = new Uint8Array(0x1000);
        const body = leaf('_ftol2').slice();
        body[body.length - 2] ^= 1;
        mem.set(body, 0x100);
        const module = {
            name: 'near-miss.exe', baseAddress: 0, size: 0x1000,
            sections: [{ name: '.text', virtualAddress: 0, virtualSize: 0x1000, rawSize: 0x1000, characteristics: 0x60000020 }],
        } as unknown as LoadedPEModule;
        expect(applyNativeLeaves(mem, module)).toEqual([]);
        expect(Array.from(mem.subarray(0x100, 0x100 + body.length))).toEqual(Array.from(body));
    });

    describe.skipIf(!HAVE_V86)('executed in v86', () => {
        for (const arm of [
            { jit: false, relaxed: true }, { jit: false, relaxed: false },
            { jit: true, relaxed: true }, { jit: true, relaxed: false },
        ] satisfies Arm[]) {
            it(`original and replacement both truncate exactly (jit=${arm.jit}, relaxed x87=${arm.relaxed})`, async () => {
                const { bytes } = buildImage(arm.jit ? 100 : 1);
                const { rec, jitTruncates } = await withoutWindow(() => runArm(arm, bytes));
                expect(mismatches(rec)).toEqual([]);
                // Otherwise the JIT arm would pass on interpreted code.
                if (arm.jit) expect(jitTruncates).toBe(true);
            }, 120000);
        }
    });
});
