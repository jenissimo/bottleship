// Byte-identity snapshot test for the PUBLIC x86 stub/trampoline emitters that used to
// live on ThunkMemoryManager. Each emitter is
// driven with fixed, representative arguments against a deterministic fake allocator and
// a zeroed guest memory; the SHA-256 of every emitted region plus the returned address
// structure is frozen below.
//
// These hashes pin the EXACT machine code bytes. If a hash changes, the emitter's codegen
// changed — for a mechanical move that means the move is broken. Fix the code, do NOT
// re-freeze the hashes (re-freezing is only legitimate for a deliberate codegen change,
// reviewed as such). To regenerate after a deliberate change:
//   SNAPSHOT_PRINT=1 bun test tools/tests/thunk-stub-emitters.test.ts

import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeHeapSlabStubs } from '../../src/worker/modules/kernel32/heap-slab-stubs';
import { writeCrtSlabStubs, writeGetcStub, writeCaseFoldStubs } from '../../src/worker/modules/crt-slab-stubs';
import { writeLocaleStubs } from '../../src/worker/modules/kernel32/locale-stubs';
import { writeMbwcStubs } from '../../src/worker/modules/kernel32/mbwc-stubs';
import {
    writeShadowTrampoline,
    writeOwnerDisarmScalarTrampoline,
    writeStructCaptureTrampoline,
    writeMultiStructCaptureTrampoline,
    writeUpDrawCaptureTrampoline,
    writeIncRefStubTrampoline,
    writeDecRefStubTrampoline,
} from '../../src/worker/modules/d3d9/capture-trampolines';
import type { ShadowTrampolineSpec } from '../../src/worker/modules/d3d9/capture-trampolines';
import type { StubAllocator } from '../../src/worker/core/thunking/thunk-memory-manager';
import { LOCALE_STUB_BAIL_REASONS } from '../../src/worker/modules/kernel32/locale-data';

const PRINT = !!process.env.SNAPSHOT_PRINT;

/** 1 MiB guest memory — small, but all fake-allocated addresses land inside it. */
const MEM_SIZE = 1 << 20;

interface Ctx {
    mem: Uint8Array;
    getMemory: () => Uint8Array;
    allocator: StubAllocator;
}

/** Fresh emitter context: zeroed memory + deterministic bump allocator from 0x1000. */
function mkCtx(): Ctx {
    const mem = new Uint8Array(MEM_SIZE);
    let bump = 0x1000;
    const allocator: StubAllocator = {
        alloc(size: number): number {
            const addr = bump;
            bump = (bump + size + 15) & ~15;
            return addr;
        },
    };
    return { mem, getMemory: () => mem, allocator };
}

function sha(mem: Uint8Array, base: number, end: number): string {
    return createHash('sha256').update(mem.subarray(base, end)).digest('hex');
}

interface Snapshot {
    result: unknown;
    hashes: Record<string, string>;
}

// Fixed representative arguments (arbitrary but stable guest addresses; they are baked
// into the emitted code as imm32/disp32, so they are part of the pinned bytes).
const SLAB_CTL = 0x20000;
const LUT = 0x20100;
const TRAP_A = 0x30000;
const TRAP_B = 0x30040;
const RING_CTRL = 0x40000;
const RING_DATA = 0x40010;
const RING_CAP = 0x8000;
const OWNER_GLOBAL = 0x20400;

/** SetSamplerState-shaped spec: two range-guarded key parts folded into one slot. */
const SAMPLER_SPEC: ShadowTrampolineSpec = {
    argCount: 3,
    valueArgIndex: 2,
    slotCount: 256,
    keyParts: [
        { argIndex: 1, shift: 4, max: 16 },
        { argIndex: 2, shift: 0, max: 16 },
    ],
};

/** SetRenderState-shaped spec: single key part with max > 0x7F (imm32 cmp form). */
const RENDERSTATE_SPEC: ShadowTrampolineSpec = {
    argCount: 3,
    valueArgIndex: 2,
    slotCount: 256,
    keyParts: [{ argIndex: 1, shift: 0, max: 256 }],
};

const cases: Record<string, (ctx: Ctx) => Snapshot> = {
    heapSlabStubs: (ctx) => {
        const r = writeHeapSlabStubs(ctx.allocator, ctx.getMemory, SLAB_CTL, LUT, TRAP_A, TRAP_B);
        return { result: r, hashes: { region: sha(ctx.mem, r.regionBase, r.regionEnd) } };
    },
    crtSlabStubs: (ctx) => {
        const r = writeCrtSlabStubs(ctx.allocator, ctx.getMemory, SLAB_CTL, LUT, TRAP_A, TRAP_B);
        return { result: r, hashes: { region: sha(ctx.mem, r.regionBase, r.regionEnd) } };
    },
    getcStub: (ctx) => {
        // Borland FILE layout: level @ +0, curp @ +20 (see msvcrt.getBorlandFileLayout).
        const r = writeGetcStub(ctx.allocator, ctx.getMemory, TRAP_A, 0, 20);
        return { result: r, hashes: { region: sha(ctx.mem, r.regionBase, r.regionEnd) } };
    },
    caseFoldStubs: (ctx) => {
        const r = writeCaseFoldStubs(ctx.allocator, ctx.getMemory, LUT, LUT + 0x100);
        return { result: r, hashes: { region: sha(ctx.mem, r.regionBase, r.regionEnd) } };
    },
    localeStubs: (ctx) => {
        const r = writeLocaleStubs(ctx.allocator, ctx.getMemory, SLAB_CTL, TRAP_A);
        return { result: r, hashes: { region: sha(ctx.mem, r.regionBase, r.regionEnd) } };
    },
    mbwcStubs: (ctx) => {
        // cp 1252 with CP_OEMCP aliased in — the shape that emits BOTH extra compares.
        const r = writeMbwcStubs(ctx.allocator, ctx.getMemory, SLAB_CTL, 1252, true, TRAP_A, TRAP_B);
        return { result: r, hashes: { region: sha(ctx.mem, r.regionBase, r.regionEnd) } };
    },
    shadowTrampolineSampler: (ctx) => {
        const r = writeShadowTrampoline(
            ctx.allocator, ctx.getMemory, RING_CTRL, RING_DATA, RING_CAP, OWNER_GLOBAL, SAMPLER_SPEC);
        return {
            result: r,
            hashes: {
                code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd),
                data: sha(ctx.mem, r.dataRegionBase, r.dataRegionEnd),
            },
        };
    },
    shadowTrampolineRenderStateNoOwner: (ctx) => {
        // lastOwnerGlobal = 0 disables the owner gate (different codegen path).
        const r = writeShadowTrampoline(
            ctx.allocator, ctx.getMemory, RING_CTRL, RING_DATA, RING_CAP, 0, RENDERSTATE_SPEC);
        return {
            result: r,
            hashes: {
                code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd),
                data: sha(ctx.mem, r.dataRegionBase, r.dataRegionEnd),
            },
        };
    },
    ownerDisarmScalarTrampoline: (ctx) => {
        const r = writeOwnerDisarmScalarTrampoline(
            ctx.allocator, ctx.getMemory, RING_CTRL, RING_DATA, RING_CAP, 1, OWNER_GLOBAL);
        return { result: r, hashes: { code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd) } };
    },
    structCaptureTrampoline: (ctx) => {
        // SetTransform-shaped: (this, pMatrix) with a 16-dword payload.
        const r = writeStructCaptureTrampoline(
            ctx.allocator, ctx.getMemory, RING_CTRL, RING_DATA, RING_CAP,
            { argCount: 2, ptrArgIndex: 1, payloadDwords: 16 });
        return { result: r, hashes: { code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd) } };
    },
    multiStructCaptureTrampoline: (ctx) => {
        // grDrawTriangle-shaped: three GrVertex* and the 12 floats a draw reads from each.
        const r = writeMultiStructCaptureTrampoline(
            ctx.allocator, ctx.getMemory, RING_CTRL, RING_DATA, RING_CAP,
            { argCount: 3, ptrArgIndices: [0, 1, 2], payloadDwords: 12 });
        return { result: r, hashes: { code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd) } };
    },
    upDrawCaptureTrampoline: (ctx) => {
        const r = writeUpDrawCaptureTrampoline(ctx.allocator, ctx.getMemory, RING_CTRL, RING_DATA, RING_CAP);
        return { result: r, hashes: { code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd) } };
    },
    incRefStubTrampoline: (ctx) => {
        // Texture9::AddRef shape: count at +4, stdcall ret 4, vtable gate word at OWNER_GLOBAL.
        const r = writeIncRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 4, popBytes: 4, expectVtableAddr: OWNER_GLOBAL });
        return { result: r, hashes: { code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd) } };
    },
    incRefStubTrampolineVerify: (ctx) => {
        const r = writeIncRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 4, popBytes: 4, expectVtableAddr: OWNER_GLOBAL, predictAddr: LUT });
        return { result: r, hashes: { code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd) } };
    },
    decRefStubTrampoline: (ctx) => {
        // Texture9::Release shape: count at +4, stdcall ret 4, vtable gate word at OWNER_GLOBAL.
        const r = writeDecRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 4, popBytes: 4, expectVtableAddr: OWNER_GLOBAL });
        return { result: r, hashes: { code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd) } };
    },
    decRefStubTrampolineVerify: (ctx) => {
        const r = writeDecRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 4, popBytes: 4, expectVtableAddr: OWNER_GLOBAL, predictAddr: LUT });
        return { result: r, hashes: { code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd) } };
    },
};

// Frozen snapshots (generated on the pre-move code; MUST NOT change across the move).
const EXPECTED: Record<string, Snapshot> = {
    heapSlabStubs: {"result":{"heapAllocStub":4096,"heapFreeStub":4253,"regionBase":4096,"regionEnd":4608},"hashes":{"region":"2e61fc6d4a8d3740e739a1e0fca6d4c05725b6053c969c64a593e6a43f6574a5"}},
    crtSlabStubs: {"result":{"mallocStub":4096,"freeStub":4235,"regionBase":4096,"regionEnd":4608},"hashes":{"region":"de7b6017ea9cffbcc44163c6080690d0a9d212f9cc38f796c5936b412579fbaa"}},
    getcStub: {"result":{"getcStub":4096,"regionBase":4096,"regionEnd":4160},"hashes":{"region":"7164114dee4b9bf1cf713e04d53500a1cf0aa472b1aa6cdc1b8a3dfad854f2c0"}},
    caseFoldStubs: {"result":{"tolowerStub":4096,"toupperStub":4108,"regionBase":4096,"regionEnd":4128},"hashes":{"region":"361bd870014fab9f407fc15d3cfe66b4e9468a933f6d6ca6aae0640e20fb0946"}},
    localeStubs: {"result":{"getLocaleInfoWStub":4096,"tableAddr":131072,"regionBase":4096,"regionEnd":4480},"hashes":{"region":"e95d8aa2c469c375bbaa8301d0727f91f1c40bb67eb48d98541cca811b745c6a"}},
    mbwcStubs: {"result":{"mbToWcStub":4096,"wcToMbStub":4570,"tableAddr":131072,"codePage":1252,"regionBase":4096,"regionEnd":5632},"hashes":{"region":"60837cbfa0d2213d9d44b4db927a172c19ad782330c129662a1065054d51dc79"}},
    shadowTrampolineSampler: {"result":{"trampAddr":5136,"shadowBase":4100,"slotCount":256,"sentinel":2147483648,"skipCounterAddr":4096,"dataRegionBase":4096,"dataRegionEnd":5124,"codeRegionBase":5136,"codeRegionEnd":5392},"hashes":{"code":"741930ffcf73a40db8441fb9bb641dfbccba2b2c42557dcd7a699f5a89bd1b49","data":"496f0eda84c76c10945e95128f4f8b16a640633720f19ab135d044da70da04fc"}},
    shadowTrampolineRenderStateNoOwner: {"result":{"trampAddr":5136,"shadowBase":4100,"slotCount":256,"sentinel":2147483648,"skipCounterAddr":4096,"dataRegionBase":4096,"dataRegionEnd":5124,"codeRegionBase":5136,"codeRegionEnd":5392},"hashes":{"code":"7a68f74852f7dd022d3f1da86a9ff701adc75aecd71a88664f10eb1a70b42d49","data":"496f0eda84c76c10945e95128f4f8b16a640633720f19ab135d044da70da04fc"}},
    ownerDisarmScalarTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4224},"hashes":{"code":"3872c71deed97fde2196b52379f1d1aa7abdf8847b81c6ffa488340c96ccc8c6"}},
    structCaptureTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4320},"hashes":{"code":"5ce49653ab8f3fa8c1218565df2c2234c05169a2d00d54a57c64d1602f2fbbed"}},
    multiStructCaptureTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4480},"hashes":{"code":"778d5a59c37081e22b58e08fa3cd1f46734670c403c3105f7567ec64ae8ec008"}},
    upDrawCaptureTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4480},"hashes":{"code":"b4d6979e6cae69666eaacb40eb06265e73b17a766266b692442734350baf3642"}},
    incRefStubTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4192},"hashes":{"code":"9a7faaaa8ece73ed7a2d8da15e1c93afec0e2f0c1157decf7705e9eb9f10a64a"}},
    incRefStubTrampolineVerify: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4192},"hashes":{"code":"ec3199f214397cfd2569bdcf846eba58dfe76c51bc8781066c83bf8ef223c553"}},
    decRefStubTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4192},"hashes":{"code":"b491b6114215578d3ea5aacbcd6b156b40be93580cf72fbd291fcc3496c6e035"}},
    decRefStubTrampolineVerify: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4192},"hashes":{"code":"1cea723cfceb0950f34efc38d5d4aa823bbb07e815100b0b59f2f54e359e15e3"}},
};

describe('an emitter that outgrows its region writes nothing outside it', () => {
    // The region check used to run AFTER the overflowing bytes had landed, and pe-loader
    // downgrades the throw to a warn — so the damage stayed in whatever THUNK_CODE follows.
    // Forcing an overflow is the only way to see the difference: the locale stub emits one
    // 9-byte landing pad per bail reason, so extra reasons grow it past its 384B region.
    it('the GetLocaleInfoW stub refuses to emit past its region', () => {
        const ctx = mkCtx();
        const reasons = LOCALE_STUB_BAIL_REASONS as unknown as string[];
        const added = 64;
        for (let i = 0; i < added; i++) reasons.push(`overflowProbe${i}`);
        try {
            const base = 0x1000;
            const REGION_SIZE = 384;   // writeLocaleStubs' own region
            const tail = base + REGION_SIZE;
            ctx.mem.fill(0xA5, tail, tail + 0x400);
            expect(() => writeLocaleStubs(ctx.allocator, ctx.getMemory, SLAB_CTL, TRAP_A))
                .toThrow(/emit past/);
            for (let i = 0; i < 0x400; i++) {
                expect(`+${i}:${ctx.mem[tail + i]}`).toBe(`+${i}:165`);
            }
        } finally {
            reasons.length -= added;
        }
    });
});

describe('thunk stub emitters — byte-identity snapshots', () => {
    for (const [name, run] of Object.entries(cases)) {
        it(name, () => {
            const actual = run(mkCtx());
            if (PRINT) {
                console.log(`    ${name}: ${JSON.stringify(actual)},`);
                return;
            }
            expect(actual).toEqual(EXPECTED[name]);
        });
    }
});
