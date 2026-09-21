/**
 * Signature-stage near-miss reporting.
 *
 * A byte/prologue signature that misses by a byte or two is what a new build of the
 * same static library looks like. Discarding that record leaves the next bring-up with
 * nothing to go on, so runDetector must warn — but only once the module has already
 * shown a hit, otherwise every module load prints the closest random bytes in a section
 * that never held the library.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { runDetector } from "../../src/worker/core/hle-lib/lib-detector";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { Logger } from "../../src/worker/core/logger";
import type { LoadedPEModule } from "../../src/worker/core/module-registry";
import type { LibDescriptor } from "../../src/worker/core/hle-lib/types";

const BASE = 0x400000;
const TEXT_RVA = 0x1000;
const RDATA_RVA = 0x2000;
const SECTION_SIZE = 0x100;

const MARKER = "libfoo 1.2.3";
/** A plausible MSVC prologue: push ebp; mov ebp,esp; sub esp,0x38; push esi. */
const PROLOGUE = new Uint8Array([0x55, 0x8b, 0xec, 0x83, 0xec, 0x38, 0x56]);

let mem: Uint8Array;
let warns: string[];
let realWarn: typeof Logger.warn;

function mkModule(): LoadedPEModule {
    return {
        name: "game.exe",
        path: "C:\\game.exe",
        baseAddress: BASE,
        size: 0x10000,
        entryPoint: 0,
        exports: new Map(),
        ordinalExports: new Map(),
        isRealDll: false,
        initialized: true,
        sections: [
            { name: ".text", virtualAddress: TEXT_RVA, virtualSize: SECTION_SIZE, rawSize: SECTION_SIZE, characteristics: 0 },
            { name: ".rdata", virtualAddress: RDATA_RVA, virtualSize: SECTION_SIZE, rawSize: SECTION_SIZE, characteristics: 0 },
        ],
    };
}

function mkDescriptor(): LibDescriptor {
    return {
        id: "libfoo",
        displayName: "libfoo (test)",
        minConfidence: 100,
        signatures: {
            versionString: { kind: "ascii", text: MARKER, weight: 60 },
            decodePrologue: { kind: "prologue", pattern: PROLOGUE, mask: "xxxxxxx", weight: 50 },
        },
        functions: {},
        handlers: {},
    };
}

/** Plant the version string, and the prologue with `diff` of its bytes altered. */
function plant(diff: number): void {
    mem.fill(0);
    for (let i = 0; i < MARKER.length; i++) mem[BASE + RDATA_RVA + 0x20 + i] = MARKER.charCodeAt(i);
    const at = BASE + TEXT_RVA + 0x40;
    for (let i = 0; i < PROLOGUE.length; i++) mem[at + i] = PROLOGUE[i];
    for (let i = 0; i < diff; i++) mem[at + PROLOGUE.length - 1 - i] ^= 0xff;
}

beforeEach(() => {
    mem = new Uint8Array(BASE + 0x10000);
    Mem.bind(() => mem);
    warns = [];
    realWarn = Logger.warn.bind(Logger);
    (Logger as any).warn = (_cat: unknown, msg: string) => { warns.push(msg); };
});

afterEach(() => {
    (Logger as any).warn = realWarn;
});

describe("runDetector signature near-miss", () => {
    test("a one-byte prologue difference is named, with descriptor, address and closeness", () => {
        plant(1);
        expect(runDetector(mkDescriptor(), mkModule())).toBeNull(); // 60 < minConfidence 100

        const line = warns.find(w => w.includes("decodePrologue"));
        expect(line).toBeDefined();
        expect(line).toContain("libfoo (libfoo (test))");
        expect(line).toContain("NOT MATCHED in game.exe");
        expect(line).toContain("confidence 60/100");
        expect(line).toContain(`best match 6/7 bytes at 0x${(BASE + TEXT_RVA + 0x40).toString(16)}`);
        expect(line).toContain("expected: 55 8b ec 83 ec 38 56");
        expect(line).toContain("actual:   55 8b ec 83 ec 38 a9");
    });

    test("no hit in the module means no near-miss noise", () => {
        plant(1);
        // Drop the version string: nothing of the library is here, so the closest
        // prologue prefix is meaningless and must stay silent.
        mem.fill(0, BASE + RDATA_RVA, BASE + RDATA_RVA + SECTION_SIZE);
        expect(runDetector(mkDescriptor(), mkModule())).toBeNull();
        expect(warns).toEqual([]);
    });

    test("an exact match warns about nothing", () => {
        plant(0);
        const match = runDetector(mkDescriptor(), mkModule());
        expect(match?.confidence).toBe(110);
        expect(warns).toEqual([]);
    });

    test("one line per missed signature, not per scan position", () => {
        plant(1);
        runDetector(mkDescriptor(), mkModule());
        expect(warns.filter(w => w.includes("decodePrologue")).length).toBe(1);
    });
});
