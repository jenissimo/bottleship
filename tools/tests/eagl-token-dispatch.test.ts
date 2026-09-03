/**
 * EAGL token-dispatch guest filter — byte-layout + routing tests.
 *
 * The filter is hand-assembled x86 (token-dispatch-filter.ts); a mis-encoded
 * rel32 or a wrong ModRM silently corrupts control flow at 1M calls/s, so this
 * test (a) pins the encoding via a symbolic executor that walks exactly the
 * instructions the assembler is allowed to emit, and (b) verifies the routing
 * decision — {1,2,8} → stub, class 6 → stub unless commit mode ([ecx+0x84]) is
 * 2 (state-block record → original), everything else → trampoline, disarmed →
 * trampoline, alias-node indirection honored — against a synthetic guest memory
 * image. Mirrors thunk-stub-emitters.test.ts's role for the WBUF trampolines.
 *
 * TIER 0 gets the same treatment plus one more: the executor checks that ESP,
 * EBX and ESI are restored on EVERY exit. The skip path is the only route in
 * the project that RETs from a filter, so a leaked push would corrupt the
 * caller's frame rather than fail visibly.
 */

import { describe, expect, test } from 'bun:test';
import {
    FILTER_ENABLED_FLAG_OFF,
    FILTER_SKIP_MODE_OFF,
    FILTER_CFG_RING_CTRL,
    FILTER_CFG_OWNER_GLOBAL,
    FILTER_CFG_SRS_FID,
    FILTER_CFG_SRS_SHADOW,
    FILTER_CFG_SAMP_FID,
    FILTER_CFG_SAMP_SHADOW,
    FILTER_CFG_RING_LIMIT,
    FILTER_CFG_SKIP_SRS,
    FILTER_CFG_SKIP_SAMP,
    assembleTokenDispatchFilter,
    tokenDispatchFilterSize,
} from '../../src/worker/core/hle-lib/libs/eagl/token-dispatch-filter';

const FILTER = 0x2114_0000;
const CFG = 0x0060_0000;
const TBL = 0x006d_c274;
const STUB = 0x2100_0100;
const TRAMP = 0x2100_0200;
const NODE = 0x0070_0000;
const ALIAS = 0x0070_4000;

const CTX = 0x0071_0000;      // ECX = EAGL device ctx; commit mode at +0x84
const DEV = 0x0072_0000;      // IDirect3DDevice9 `this`
const VTABLE = 0x0073_0000;
const SRS_STUB = 0x2100_1000; // our WBUF setter stub for SetRenderState
const SAMP_STUB = 0x2100_1100;
const SRS_SHADOW = 0x0074_0000;
const SAMP_SHADOW = 0x0074_1000;
const OWNER_GLOBAL = 0x0075_0000;
const RING_CTRL = 0x0076_0000;
const SRS_FID = 0x41;
const SAMP_FID = 0x42;
const RING_LIMIT = 0x1000;

const VT_SRS = 0xe4;
const VT_SAMP = 0x114;

/** Build a sparse guest memory via a Map-backed accessor (only pages we touch). */
class MiniMem {
    private m = new Map<number, number>();
    read8(a: number): number { return this.m.get(a >>> 0) ?? 0; }
    write8(a: number, v: number): void { this.m.set(a >>> 0, v & 0xff); }
    read32(a: number): number {
        return (this.read8(a) | (this.read8(a + 1) << 8) | (this.read8(a + 2) << 16) | (this.read8(a + 3) << 24)) >>> 0;
    }
    write32(a: number, v: number): void {
        for (let i = 0; i < 4; i++) this.write8(a + i, (v >>> (i * 8)) & 0xff);
    }
    load(base: number, bytes: Uint8Array): void {
        for (let i = 0; i < bytes.length; i++) this.write8(base + i, bytes[i]);
    }
}

type Outcome =
    | { kind: 'stub' }
    | { kind: 'tramp' }
    | { kind: 'skip'; eax: number; retPop: number };

/**
 * Execute the filter symbolically: supports exactly the encodings the assembler
 * emits. Throws on any unrecognized byte — encoding drift fails loudly — and on
 * a callee-saved register or ESP left unrestored at an exit.
 */
function runFilter(mem: MiniMem, entry: number, regs: { ecx: number; esp: number }): Outcome {
    let eip = entry >>> 0;
    let eax = 0, edx = 0, ebx = 0x0bad0bad, esi = 0x0bad51e5;
    const ebx0 = ebx, esi0 = esi;
    let esp = regs.esp >>> 0;
    const esp0 = esp;
    const ecx = regs.ecx >>> 0;
    let zf = false, cf = false, sf = false, of = false;

    const cmp = (a: number, b: number) => {
        const ua = a >>> 0, ub = b >>> 0;
        const r = (a - b) | 0;
        zf = ua === ub;
        cf = ua < ub;
        sf = r < 0;
        of = ((((a ^ b) & (a ^ r)) >>> 0) & 0x8000_0000) !== 0;
    };
    const test = (a: number, b: number) => {
        const r = (a & b) | 0;
        zf = r === 0; sf = r < 0; cf = false; of = false;
    };
    const exit = (o: Outcome): Outcome => {
        if (esp !== esp0) throw new Error(`ESP not restored at exit: 0x${esp.toString(16)} != 0x${esp0.toString(16)}`);
        if (ebx !== ebx0) throw new Error('EBX (callee-saved) not restored at exit');
        if (esi !== esi0) throw new Error('ESI (callee-saved) not restored at exit');
        return o;
    };
    const rel32 = (at: number) => mem.read32(at) | 0;
    const imm8s = (at: number) => (mem.read8(at) << 24) >> 24;

    for (let steps = 0; steps < 256; steps++) {
        const b0 = mem.read8(eip), b1 = mem.read8(eip + 1), b2 = mem.read8(eip + 2);
        if (b0 === 0x80 && b1 === 0x3d) {                       // cmp byte [imm32], imm8
            cmp(mem.read8(mem.read32(eip + 2)), mem.read8(eip + 6));
            eip += 7;
        } else if (b0 === 0x80 && b1 === 0x3b) {                // cmp byte [ebx], imm8
            cmp(mem.read8(ebx), mem.read8(eip + 2));
            eip += 3;
        } else if (b0 === 0x0f) {                               // Jcc rel32
            const take =
                b1 === 0x84 ? zf :
                b1 === 0x85 ? !zf :
                b1 === 0x82 ? cf :
                b1 === 0x83 ? !cf :
                b1 === 0x88 ? sf :
                b1 === 0x8d ? sf === of :
                (() => { throw new Error(`unknown Jcc 0f ${b1.toString(16)}`); })();
            eip = take ? (eip + 6 + rel32(eip + 2)) >>> 0 : eip + 6;
        } else if (b0 === 0x75) {                               // jne rel8
            eip = zf ? eip + 2 : (eip + 2 + imm8s(eip + 1)) >>> 0;
        } else if (b0 === 0x83 && b1 === 0xb9) {                // cmp dword [ecx+imm32], imm8
            cmp(mem.read32((ecx + (mem.read32(eip + 2) | 0)) >>> 0) | 0, imm8s(eip + 6));
            eip += 7;
        } else if (b0 === 0x83 && b1 === 0xf8) { cmp(eax | 0, imm8s(eip + 2)); eip += 3; }
        else if (b0 === 0x83 && b1 === 0xfb) { cmp(ebx | 0, imm8s(eip + 2)); eip += 3; }
        else if (b0 === 0x83 && b1 === 0xfe) { cmp(esi | 0, imm8s(eip + 2)); eip += 3; }
        else if (b0 === 0x3d) { cmp(eax | 0, mem.read32(eip + 1) | 0); eip += 5; }
        else if (b0 === 0x3c) { cmp(eax & 0xff, mem.read8(eip + 1)); eip += 2; }   // cmp al, imm8
        else if (b0 === 0xc1 && b1 === 0xc0) {                                     // rol eax, imm8
            const n = mem.read8(eip + 2) & 31;
            eax = n === 0 ? eax : (((eax << n) | (eax >>> (32 - n))) >>> 0);
            eip += 3;
        }
        else if (b0 === 0x25) { eax = (eax & mem.read32(eip + 1)) >>> 0; zf = eax === 0; cf = false; of = false; sf = (eax | 0) < 0; eip += 5; }
        else if (b0 === 0x85 && b1 === 0xd2) { test(edx | 0, edx | 0); eip += 2; }
        else if (b0 === 0x85 && b1 === 0xdb) { test(ebx | 0, ebx | 0); eip += 2; }
        else if (b0 === 0x8b && b1 === 0x54 && b2 === 0x24) { edx = mem.read32(esp + mem.read8(eip + 3)); eip += 4; }
        else if (b0 === 0x8b && b1 === 0x74 && b2 === 0x24) { esi = mem.read32(esp + mem.read8(eip + 3)); eip += 4; }
        else if (b0 === 0x8b && b1 === 0x02) { eax = mem.read32(edx); eip += 2; }
        else if (b0 === 0x8b && b1 === 0x52) { edx = mem.read32(edx + mem.read8(eip + 2)); eip += 3; }
        else if (b0 === 0x8b && b1 === 0x5b) { ebx = mem.read32(ebx + mem.read8(eip + 2)); eip += 3; }
        else if (b0 === 0x8b && b1 === 0x76) { esi = mem.read32(esi + mem.read8(eip + 2)); eip += 3; }
        else if (b0 === 0x8b && b1 === 0x71) { esi = mem.read32(ecx + mem.read8(eip + 2)); eip += 3; }
        else if (b0 === 0x8b && b1 === 0x1e) { ebx = mem.read32(esi); eip += 2; }
        else if (b0 === 0x8b && b1 === 0x1b) { ebx = mem.read32(ebx); eip += 2; }
        else if (b0 === 0x8b && b1 === 0x1d) { ebx = mem.read32(mem.read32(eip + 2)); eip += 6; }
        else if (b0 === 0x8b && b1 === 0x80) { eax = mem.read32((eax + mem.read32(eip + 2)) >>> 0); eip += 6; }
        else if (b0 === 0x8b && b1 === 0x9b) { ebx = mem.read32((ebx + mem.read32(eip + 2)) >>> 0); eip += 6; }
        else if (b0 === 0x3b && b1 === 0x1d) { cmp(ebx | 0, mem.read32(mem.read32(eip + 2)) | 0); eip += 6; }
        else if (b0 === 0x3b && b1 === 0x33) { cmp(esi | 0, mem.read32(ebx) | 0); eip += 2; }
        else if (b0 === 0x39 && b1 === 0x14 && b2 === 0x83) { cmp(mem.read32((ebx + eax * 4) >>> 0) | 0, edx | 0); eip += 3; }
        else if (b0 === 0x6b && b1 === 0xc0) { eax = Math.imul(eax, mem.read8(eip + 2)) >>> 0; eip += 3; }
        else if (b0 === 0xc1 && b1 === 0xe8) { eax = eax >>> mem.read8(eip + 2); eip += 3; }
        else if (b0 === 0xc1 && b1 === 0xeb) { ebx = ebx >>> mem.read8(eip + 2); eip += 3; }
        else if (b0 === 0xc1 && b1 === 0xe6) { esi = (esi << mem.read8(eip + 2)) >>> 0; eip += 3; }
        else if (b0 === 0x09 && b1 === 0xf0) { eax = (eax | esi) >>> 0; eip += 2; }
        else if (b0 === 0x89 && b1 === 0xc3) { ebx = eax; eip += 2; }
        else if (b0 === 0x31 && b1 === 0xc0) { eax = 0; eip += 2; }
        else if (b0 === 0xff && b1 === 0x05) {                  // inc dword [imm32]
            const a = mem.read32(eip + 2);
            mem.write32(a, (mem.read32(a) + 1) >>> 0);
            eip += 6;
        }
        else if (b0 === 0x53) { esp = (esp - 4) >>> 0; mem.write32(esp, ebx); eip += 1; }
        else if (b0 === 0x56) { esp = (esp - 4) >>> 0; mem.write32(esp, esi); eip += 1; }
        else if (b0 === 0x5b) { ebx = mem.read32(esp); esp = (esp + 4) >>> 0; eip += 1; }
        else if (b0 === 0x5e) { esi = mem.read32(esp); esp = (esp + 4) >>> 0; eip += 1; }
        else if (b0 === 0xc2) {                                 // ret imm16
            return exit({ kind: 'skip', eax: eax >>> 0, retPop: mem.read8(eip + 1) | (mem.read8(eip + 2) << 8) });
        }
        else if (b0 === 0xe9) {                                 // jmp rel32
            const target = (eip + 5 + rel32(eip + 1)) >>> 0;
            if (target === STUB) return exit({ kind: 'stub' });
            if (target === TRAMP) return exit({ kind: 'tramp' });
            throw new Error(`jmp to unexpected 0x${target.toString(16)}`);
        }
        else throw new Error(`unrecognized byte 0x${b0.toString(16)} ${b1.toString(16)} at +0x${(eip - entry).toString(16)}`);
    }
    throw new Error('filter did not terminate in 256 steps');
}

interface SetupOpts {
    armed: boolean;
    token: number;
    cls: number;
    alias?: boolean;
    mode?: number;
    /** Tier-0 cfg mode byte: 0 off, 1 live, 2 oracle. */
    skipMode?: number;
    /** Descriptor enum (low 24 bits) — the render/sampler state id. */
    enumId?: number;
    /** stdcall arg1 (stage). */
    stage?: number;
    /** node[0x1a] — the value being set. */
    value?: number;
    /** What the shadow slot currently holds (default: a mismatch). */
    shadow?: number;
    ringHead?: number;
}

function setup(opts: SetupOpts): { mem: MiniMem; esp: number; ecx: number } {
    const mem = new MiniMem();
    mem.load(FILTER, assembleTokenDispatchFilter(FILTER, CFG, TBL, STUB, TRAMP).code);
    mem.write8(CFG + FILTER_ENABLED_FLAG_OFF, opts.armed ? 1 : 0);
    mem.write8(CFG + FILTER_SKIP_MODE_OFF, opts.skipMode ?? 0);
    // token descriptor: class<<24 | enum
    const enumId = opts.enumId ?? 0x000123;
    mem.write32(TBL + opts.token * 0x1c, ((opts.cls << 24) | enumId) >>> 0);
    mem.write32(CTX + 0x84, opts.mode ?? 3); // commit mode (3 = direct apply)

    // Device wiring: ctx→dev→vtable→our WBUF setter stubs (`B8 <funcId>`).
    mem.write32(CTX + 8, DEV);
    mem.write32(DEV, VTABLE);
    mem.write32(VTABLE + VT_SRS, SRS_STUB);
    mem.write32(VTABLE + VT_SAMP, SAMP_STUB);
    mem.write8(SRS_STUB, 0xb8); mem.write32(SRS_STUB + 1, SRS_FID);
    mem.write8(SAMP_STUB, 0xb8); mem.write32(SAMP_STUB + 1, SAMP_FID);
    mem.write32(CFG + FILTER_CFG_SRS_FID, SRS_FID);
    mem.write32(CFG + FILTER_CFG_SAMP_FID, SAMP_FID);
    mem.write32(CFG + FILTER_CFG_SRS_SHADOW, SRS_SHADOW);
    mem.write32(CFG + FILTER_CFG_SAMP_SHADOW, SAMP_SHADOW);
    mem.write32(CFG + FILTER_CFG_OWNER_GLOBAL, OWNER_GLOBAL);
    mem.write32(OWNER_GLOBAL, DEV);
    mem.write32(CFG + FILTER_CFG_RING_CTRL, RING_CTRL);
    mem.write32(RING_CTRL, opts.ringHead ?? 0);
    mem.write32(CFG + FILTER_CFG_RING_LIMIT, RING_LIMIT);

    const esp = 0x0080_0000;
    mem.write32(esp + 4, NODE);                       // arg0 = node
    mem.write32(esp + 8, opts.stage ?? 0xffffffff);   // arg1 = stage
    const n = opts.alias ? ALIAS : NODE;
    if (opts.alias) {
        mem.write32(NODE, 0xffffffff);    // node[0] = -1 → alias
        mem.write32(NODE + 0x64, ALIAS);  // node[0x19]
        mem.write32(ALIAS, opts.token);
    } else {
        mem.write32(NODE, opts.token);
    }
    mem.write32(NODE + 4, 0);                         // rawNode[1] — stage fallback
    mem.write32(n + 0x68, opts.value ?? 0xa5a5a5a5);  // n[0x1a] = value
    const slot = opts.cls === 8
        ? ((((opts.stage ?? 0) & 0xf) << 4) | (enumId & 0xf))
        : (enumId & 0xffffff);
    const shadowBase = opts.cls === 8 ? SAMP_SHADOW : SRS_SHADOW;
    mem.write32(shadowBase + slot * 4, opts.shadow ?? 0x1234_5678);
    return { mem, esp, ecx: CTX };
}

const route = (r: Outcome) => r.kind;

describe('eagl token-dispatch filter', () => {
    test('size is stable and address-independent', () => {
        const n = tokenDispatchFilterSize();
        expect(n).toBeGreaterThan(60);
        expect(assembleTokenDispatchFilter(0x9990_0000, CFG, TBL, STUB, TRAMP).code.length).toBe(n);
    });

    test('disarmed gate routes EVERYTHING to the original', () => {
        for (const cls of [1, 2, 8, 3, 6]) {
            const { mem, esp, ecx } = setup({ armed: false, token: 7, cls, skipMode: 1 });
            expect(route(runFilter(mem, FILTER, { ecx, esp }))).toBe('tramp');
        }
    });

    test('armed: classes 1/2/8 → stub', () => {
        for (const cls of [1, 2, 8]) {
            const { mem, esp, ecx } = setup({ armed: true, token: 7, cls });
            expect(route(runFilter(mem, FILTER, { ecx, esp }))).toBe('stub');
        }
    });

    test('armed: classes 3/4/5/7/9/10 → original', () => {
        for (const cls of [3, 4, 5, 7, 9, 10]) {
            const { mem, esp, ecx } = setup({ armed: true, token: 7, cls });
            expect(route(runFilter(mem, FILTER, { ecx, esp }))).toBe('tramp');
        }
    });

    test('armed: class 6 → stub in modes 1/3, original in record mode 2', () => {
        for (const mode of [1, 3]) {
            const { mem, esp, ecx } = setup({ armed: true, token: 7, cls: 6, mode });
            expect(route(runFilter(mem, FILTER, { ecx, esp }))).toBe('stub');
        }
        const rec = setup({ armed: true, token: 7, cls: 6, mode: 2 });
        expect(route(runFilter(rec.mem, FILTER, { ecx: rec.ecx, esp: rec.esp }))).toBe('tramp');
    });

    test('null node → original (same #PF surface as guest)', () => {
        const { mem, esp, ecx } = setup({ armed: true, token: 7, cls: 1 });
        mem.write32(esp + 4, 0);
        expect(route(runFilter(mem, FILTER, { ecx, esp }))).toBe('tramp');
    });

    test('alias node (token -1 → node[0x19]) is followed', () => {
        const { mem, esp, ecx } = setup({ armed: true, token: 9, cls: 8, alias: true });
        expect(route(runFilter(mem, FILTER, { ecx, esp }))).toBe('stub');
        const t2 = setup({ armed: true, token: 9, cls: 4, alias: true });
        expect(route(runFilter(t2.mem, FILTER, { ecx: t2.ecx, esp: t2.esp }))).toBe('tramp');
        const t3 = setup({ armed: true, token: 9, cls: 6, alias: true, mode: 2 });
        expect(route(runFilter(t3.mem, FILTER, { ecx: t3.ecx, esp: t3.esp }))).toBe('tramp');
        const t4 = setup({ armed: true, token: 9, cls: 6, alias: true, mode: 3 });
        expect(route(runFilter(t4.mem, FILTER, { ecx: t4.ecx, esp: t4.esp }))).toBe('stub');
    });

    test('token stride is 0x1c (descriptor for token N read at TBL+N*0x1c)', () => {
        const { mem, esp, ecx } = setup({ armed: true, token: 3, cls: 1 });
        // poison the neighbours — routing must still come from token 3's slot
        mem.write32(TBL + 2 * 0x1c, (4 << 24) >>> 0);
        mem.write32(TBL + 4 * 0x1c, (4 << 24) >>> 0);
        expect(route(runFilter(mem, FILTER, { ecx, esp }))).toBe('stub');
    });
});

// ── Tier 0: the redundant set answered in guest code ────────────────────────

/** A class-1 (SetRenderState) redundant set: shadow already holds the value. */
const redundantSrs = (over: Partial<SetupOpts> = {}) => setup({
    armed: true, token: 7, cls: 1, skipMode: 1,
    enumId: 0x20, value: 0x3333, shadow: 0x3333, ...over,
});
/** A class-8 (SetSamplerState) redundant set at stage 3, state 5. */
const redundantSamp = (over: Partial<SetupOpts> = {}) => setup({
    armed: true, token: 7, cls: 8, skipMode: 1,
    enumId: 5, stage: 3, value: 0x4444, shadow: 0x4444, ...over,
});

describe('eagl token-dispatch filter — Tier 0 (guest-side redundant-set skip)', () => {
    test('class 1: redundant set RETs D3D_OK without crossing', () => {
        const { mem, esp, ecx } = redundantSrs();
        const r = runFilter(mem, FILTER, { ecx, esp });
        expect(r.kind).toBe('skip');
        expect((r as { eax: number }).eax).toBe(0);
        expect((r as { retPop: number }).retPop).toBe(8);   // stdcall (node, stage)
        expect(mem.read32(CFG + FILTER_CFG_SKIP_SRS)).toBe(1);
        expect(mem.read32(CFG + FILTER_CFG_SKIP_SAMP)).toBe(0);
    });

    test('class 8: folds (stage<<4)|state and skips on the folded slot', () => {
        const { mem, esp, ecx } = redundantSamp();
        expect(route(runFilter(mem, FILTER, { ecx, esp }))).toBe('skip');
        expect(mem.read32(CFG + FILTER_CFG_SKIP_SAMP)).toBe(1);
        // the slot really is (3<<4)|5 — poisoning it alone must undo the skip
        const b = redundantSamp();
        b.mem.write32(SAMP_SHADOW + ((3 << 4) | 5) * 4, 0xdead);
        expect(route(runFilter(b.mem, FILTER, { ecx: b.ecx, esp: b.esp }))).toBe('stub');
    });

    test('class 8: stage == -1 falls back to rawNode[1], through an alias node', () => {
        // stage arg is -1, so the fold must use NODE+4 (the RAW node), not the alias.
        const s = redundantSamp({ alias: true, stage: -1 });
        s.mem.write32(NODE + 4, 2);                       // rawNode[1] = stage 2
        s.mem.write32(ALIAS + 0x68, 0x4444);              // value on the ALIAS node
        s.mem.write32(SAMP_SHADOW + ((2 << 4) | 5) * 4, 0x4444);
        expect(route(runFilter(s.mem, FILTER, { ecx: s.ecx, esp: s.esp }))).toBe('skip');
        // and it is genuinely reading rawNode[1]: change it and the fold moves
        const t = redundantSamp({ alias: true, stage: -1 });
        t.mem.write32(NODE + 4, 7);
        t.mem.write32(ALIAS + 0x68, 0x4444);
        t.mem.write32(SAMP_SHADOW + ((2 << 4) | 5) * 4, 0x4444);
        expect(route(runFilter(t.mem, FILTER, { ecx: t.ecx, esp: t.esp }))).toBe('stub');
    });

    test('a REAL change never skips — it goes to the handler', () => {
        const a = redundantSrs({ shadow: 0x9999 });
        expect(route(runFilter(a.mem, FILTER, { ecx: a.ecx, esp: a.esp }))).toBe('stub');
        expect(a.mem.read32(CFG + FILTER_CFG_SKIP_SRS)).toBe(0);
        const b = redundantSamp({ shadow: 0x9999 });
        expect(route(runFilter(b.mem, FILTER, { ecx: b.ecx, esp: b.esp }))).toBe('stub');
    });

    test('mode 0 disables Tier 0 entirely (the A/B arm)', () => {
        const { mem, esp, ecx } = redundantSrs({ skipMode: 0 });
        expect(route(runFilter(mem, FILTER, { ecx, esp }))).toBe('stub');
        expect(mem.read32(CFG + FILTER_CFG_SKIP_SRS)).toBe(0);
    });

    test('mode 2 (oracle) counts the prediction and still crosses', () => {
        const { mem, esp, ecx } = redundantSrs({ skipMode: 2 });
        expect(route(runFilter(mem, FILTER, { ecx, esp }))).toBe('stub');
        expect(mem.read32(CFG + FILTER_CFG_SKIP_SRS)).toBe(1);
        const s = redundantSamp({ skipMode: 2 });
        expect(route(runFilter(s.mem, FILTER, { ecx: s.ecx, esp: s.esp }))).toBe('stub');
        expect(s.mem.read32(CFG + FILTER_CFG_SKIP_SAMP)).toBe(1);
    });

    test('every gate the handler applies declines here too', () => {
        const decline = (name: string, mut: (m: MiniMem) => void, base = redundantSrs) => {
            const { mem, esp, ecx } = base();
            mut(mem);
            expect(`${name}:${route(runFilter(mem, FILTER, { ecx, esp }))}`).toBe(`${name}:stub`);
            expect(mem.read32(CFG + FILTER_CFG_SKIP_SRS) + mem.read32(CFG + FILTER_CFG_SKIP_SAMP)).toBe(0);
        };
        decline('vtable slot is not our stub', m => m.write8(SRS_STUB, 0x90));
        decline('funcId is another stub', m => m.write32(SRS_STUB + 1, SRS_FID + 1));
        decline('funcId is zero', m => { m.write32(SRS_STUB + 1, 0); m.write32(CFG + FILTER_CFG_SRS_FID, 0); });
        decline('ring head negative', m => m.write32(RING_CTRL, 0xffffffff));
        decline('ring head at the limit', m => m.write32(RING_CTRL, RING_LIMIT));
        decline('owner global unset', m => m.write32(CFG + FILTER_CFG_OWNER_GLOBAL, 0));
        decline('another device is bound', m => m.write32(OWNER_GLOBAL, DEV + 0x100));
        decline('no shadow table', m => m.write32(CFG + FILTER_CFG_SRS_SHADOW, 0));
        decline('sampler: no shadow table', m => m.write32(CFG + FILTER_CFG_SAMP_SHADOW, 0), redundantSamp as typeof redundantSrs);
    });

    test('out-of-range folds decline (256 for render state, 16 for sampler)', () => {
        const a = redundantSrs({ enumId: 0x100 });
        expect(route(runFilter(a.mem, FILTER, { ecx: a.ecx, esp: a.esp }))).toBe('stub');
        const b = redundantSamp({ enumId: 16 });
        expect(route(runFilter(b.mem, FILTER, { ecx: b.ecx, esp: b.esp }))).toBe('stub');
        const c = redundantSamp({ stage: 16 });
        expect(route(runFilter(c.mem, FILTER, { ecx: c.ecx, esp: c.esp }))).toBe('stub');
        // ring head just below the limit is still in range
        const d = redundantSrs({ ringHead: RING_LIMIT - 1 });
        expect(route(runFilter(d.mem, FILTER, { ecx: d.ecx, esp: d.esp }))).toBe('skip');
    });

    test('class 2 has no shadow and never reaches Tier 0', () => {
        const { mem, esp, ecx } = setup({ armed: true, token: 7, cls: 2, skipMode: 1, enumId: 4, value: 1, shadow: 1 });
        expect(route(runFilter(mem, FILTER, { ecx, esp }))).toBe('stub');
        expect(mem.read32(CFG + FILTER_CFG_SKIP_SRS) + mem.read32(CFG + FILTER_CFG_SKIP_SAMP)).toBe(0);
    });

    test('commitRanges cover exactly the counter increments', () => {
        const { code, commitRanges } = assembleTokenDispatchFilter(FILTER, CFG, TBL, STUB, TRAMP);
        expect(commitRanges.length).toBe(2);
        for (const r of commitRanges) {
            const off = r.start - FILTER;
            expect(r.end - r.start).toBe(6);          // FF 05 imm32
            expect(code[off]).toBe(0xff);
            expect(code[off + 1]).toBe(0x05);
        }
    });
});
