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
    heapSlabStubs: {"result":{"heapAllocStub":4096,"heapFreeStub":4263,"regionBase":4096,"regionEnd":4608},"hashes":{"region":"4de9722997e8271084f9315e0fe9e0c3bae177fd2475c18ac2808a4a1ddb1c08"}},
    crtSlabStubs: {"result":{"mallocStub":4096,"freeStub":4245,"regionBase":4096,"regionEnd":4608},"hashes":{"region":"1a43f680b399c70a0ae1f452b9f0940f4978ec37e0b07022ce977dd205329870"}},
    getcStub: {"result":{"getcStub":4096,"regionBase":4096,"regionEnd":4160},"hashes":{"region":"7164114dee4b9bf1cf713e04d53500a1cf0aa472b1aa6cdc1b8a3dfad854f2c0"}},
    caseFoldStubs: {"result":{"tolowerStub":4096,"toupperStub":4108,"regionBase":4096,"regionEnd":4128},"hashes":{"region":"361bd870014fab9f407fc15d3cfe66b4e9468a933f6d6ca6aae0640e20fb0946"}},
    localeStubs: {"result":{"getLocaleInfoWStub":4096,"tableAddr":131072,"regionBase":4096,"regionEnd":4608},"hashes":{"region":"b393bd49291ee6c29070494be5f94fdd2e20de66702baeca337f7f487c6303ab"}},
    mbwcStubs: {"result":{"mbToWcStub":4096,"wcToMbStub":4570,"tableAddr":131072,"codePage":1252,"regionBase":4096,"regionEnd":5632},"hashes":{"region":"60837cbfa0d2213d9d44b4db927a172c19ad782330c129662a1065054d51dc79"}},
    shadowTrampolineSampler: {"result":{"trampAddr":5136,"shadowBase":4100,"slotCount":256,"sentinel":2147483648,"skipCounterAddr":4096,"dataRegionBase":4096,"dataRegionEnd":5124,"codeRegionBase":5136,"codeRegionEnd":5392},"hashes":{"code":"e20e8f6c5fd9413703a668ac8d6f2b4020da3b7e1a727cbe47ab0c01a6c8fa51","data":"496f0eda84c76c10945e95128f4f8b16a640633720f19ab135d044da70da04fc"}},
    shadowTrampolineRenderStateNoOwner: {"result":{"trampAddr":5136,"shadowBase":4100,"slotCount":256,"sentinel":2147483648,"skipCounterAddr":4096,"dataRegionBase":4096,"dataRegionEnd":5124,"codeRegionBase":5136,"codeRegionEnd":5392},"hashes":{"code":"7597cccb6d6fb035cc72331aa3c084d7ae9a821ff754cfb2271b7d7da068264a","data":"496f0eda84c76c10945e95128f4f8b16a640633720f19ab135d044da70da04fc"}},
    ownerDisarmScalarTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4224},"hashes":{"code":"79a3e4be0e25e8a1b31e6301a8f71eb32b5c9dec4c46834baacfc764a9ef2aa2"}},
    structCaptureTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4320},"hashes":{"code":"5d293abd758de09ed96fd7f134676f6d330dc1e97ae570b1f8f3bb34b928257a"}},
    multiStructCaptureTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4480},"hashes":{"code":"f15062fa65701ca1c3033e2c81bd3c8ed02a102007335fa836622d26a3b0c309"}},
    upDrawCaptureTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4480},"hashes":{"code":"b00b7b67d4d3b24635e50aff18d2d926fca36bdeacb3b6c9fbf1e79885d0220a"}},
    incRefStubTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4192},"hashes":{"code":"42e25fac653277fa0f5bc7c5d0c3b6761ee9c21b68513615269982e48376e0c6"}},
    incRefStubTrampolineVerify: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4192},"hashes":{"code":"91cc1754b0c9d3e1d6076ca455c4ca097878066bc626173c19390dfe2ea7f439"}},
    decRefStubTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4192},"hashes":{"code":"864166f1d6468d4962be68c7ffbed34e245c9980bd9b618d47c871272c6ec49e"}},
    decRefStubTrampolineVerify: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4192},"hashes":{"code":"9c82f5f67c11dec63a3ae2e9f12f5e0732eb1b51d8b1104bd5a108bd05fc12d6"}},
};

describe('an emitter that outgrows its region writes nothing outside it', () => {
    // The region check used to run AFTER the overflowing bytes had landed, and pe-loader
    // downgrades the throw to a warn — so the damage stayed in whatever THUNK_CODE follows.
    // Forcing an overflow is the only way to see the difference: the locale stub emits one
    // 11-byte landing pad per bail reason, so extra reasons grow it past its 512B region.
    it('the GetLocaleInfoW stub refuses to emit past its region', () => {
        const ctx = mkCtx();
        const reasons = LOCALE_STUB_BAIL_REASONS as unknown as string[];
        const added = 64;
        for (let i = 0; i < added; i++) reasons.push(`overflowProbe${i}`);
        try {
            const base = 0x1000;
            const REGION_SIZE = 512;   // writeLocaleStubs' own region
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
