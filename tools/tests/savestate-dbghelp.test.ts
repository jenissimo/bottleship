import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { DbgHelp, DBGHELP_FIELDS, type DbgHelpState } from "../../src/worker/modules/dbghelp";
import { captureStackWalks, resetStackWalks } from "../../src/worker/modules/dbghelp-stackwalk";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { savestateParticipants } from "../../src/worker/savestate/participant";
import { coverageRefusal } from "../../src/worker/savestate/session";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

type Handler = (ctx: unknown, mem: Uint8Array, args: number[]) => number;

const system = System.getInstance();
const savedProcess = system.process;
const savedMem = Object.getOwnPropertyDescriptors(Mem);
const FRAME = 0x3000, FRAME64 = 0x3400, ESP = 0x8000;
const RETURNS = [0x401100, 0x401200, 0x401300];
let memory: Uint8Array;
let scans = 0;

function module(): DbgHelp & { exports: Record<string, Handler> } {
    return new DbgHelp() as never;
}

function seed(frame: number, wide: boolean, pc: number): void {
    memory.fill(0, frame, frame + 128);
    Mem.writeUint32(frame, pc);
    Mem.writeUint32(frame + (wide ? 48 : 36), ESP);
    Mem.writeUint32(frame + (wide ? 32 : 24), 0x8100);
}

function step(m: { exports: Record<string, Handler> }, frame = FRAME, wide = false): number | null {
    const ok = m.exports[wide ? "StackWalk64" : "StackWalk"]!({}, memory, [0x014c, 0, 0, frame, 0, 0, 0, 0, 0]);
    return ok ? Mem.readUint32(frame)! : null;
}

beforeEach(() => {
    memory = new Uint8Array(0x10000);
    Mem.bind(() => memory, (a, s) => a >= 0 && a + s <= memory.length);
    scans = 0;
    system.process = {
        dispatcher: { getGuestCallStack: () => { scans++; return { frames: RETURNS.map((retAddr, i) => ({ retAddr, stackOffset: 16 * i })) }; } },
    } as never;
    resetStackWalks();
});
afterEach(() => {
    resetStackWalks();
    system.process = savedProcess;
    for (const key of ["memoryGetter", "validateRange", "getRegion"]) Object.defineProperty(Mem, key, savedMem[key]!);
});

describe("dbghelp participant", () => {
    test("an idle module saves an empty table", () => {
        expect(module().captureSavestate()).toEqual({ stackWalks: [] });
    });

    test("a stack walk saved between two calls continues in a fresh session where it stopped", () => {
        const a = module();
        seed(FRAME, false, 0x401000);
        seed(FRAME64, true, 0x402000);
        expect(step(a)).toBe(0x401000);
        expect(step(a)).toBe(0x401100);
        expect(step(a, FRAME64, true)).toBe(0x402000);
        const saved = structuredClone(a.captureSavestate());
        const ram = memory.slice();
        expect(saved.stackWalks.map(row => [row[0], row[1], row[2], row[3].length])).toEqual([[FRAME, 2, 0x401100, 16], [FRAME64, 1, 0x402000, 16]]);
        const rest = [step(a), step(a), step(a)];
        expect(rest).toEqual([0x401200, 0x401300, null]);

        resetStackWalks();
        memory.set(ram);
        RETURNS.splice(0, 3, 0x501100, 0x501200, 0x501300);
        try {
            const b = module();
            b.restoreSavestate(saved);
            expect(bytes(b.captureSavestate())).toBe(bytes(saved));
            const before = scans;
            expect([step(b), step(b), step(b)]).toEqual(rest);
            expect(step(b, FRAME64, true)).toBe(0x401100);
            expect(scans).toBe(before);
            expect(captureStackWalks().map(row => row[0])).toEqual([FRAME64]);
        } finally {
            RETURNS.splice(0, 3, 0x401100, 0x401200, 0x401300);
        }
    });

    test("without the saved table the same call starts a new walk", () => {
        const a = module();
        seed(FRAME, false, 0x401000);
        step(a); step(a);
        resetStackWalks();
        const before = scans;
        expect(step(module())).toBe(0x401100);
        expect(scans).toBe(before + 1);
        expect(captureStackWalks()[0]![1]).toBe(1);
    });

    test("every instance field has a policy; every part of a saved row reaches the capture and survives a restore", () => {
        expect(Object.keys(new DbgHelp()).sort()).toEqual(Object.keys(DBGHELP_FIELDS).sort());
        const a = module();
        seed(FRAME, false, 0x401000);
        step(a);
        const base = a.captureSavestate();
        const row = base.stackWalks[0]!;
        const frames = Uint32Array.from(row[3]);
        frames[5] = 0x777777;
        const values: Record<string, DbgHelpState> = {
            framePtr: { stackWalks: [[0x3800, row[1], row[2], row[3]]] },
            index: { stackWalks: [[row[0], 3, row[2], row[3]]] },
            lastPc: { stackWalks: [[row[0], row[1], -1, row[3]]] },
            frames: { stackWalks: [[row[0], row[1], row[2], frames]] },
            rows: { stackWalks: [row, [0x3800, 0, -1, new Uint32Array(4)]] },
            empty: { stackWalks: [] },
        };
        for (const [part, value] of Object.entries(values)) {
            expect({ part, same: bytes(value) === bytes(base) }).toEqual({ part, same: false });
            const fresh = module();
            fresh.restoreSavestate(structuredClone(value));
            expect({ part, value: bytes(fresh.captureSavestate()) }).toEqual({ part, value: bytes(value) });
        }
    });

    test("a walk whose frame words are not whole frames is not restored and leaves the table as it was", () => {
        const a = module();
        seed(FRAME, false, 0x401000);
        step(a);
        const before = bytes(a.captureSavestate());
        expect(() => a.restoreSavestate({ stackWalks: [[0x3800, 0, -1, new Uint32Array(4)], [0x3900, 0, -1, new Uint32Array(6)]] }))
            .toThrow("dbghelp: a stack walk of 6 words is not a list of frames");
        expect(bytes(a.captureSavestate())).toBe(before);
    });

    test("a reset drops the walks", () => {
        const a = module();
        seed(FRAME, false, 0x401000);
        step(a);
        a.reset();
        expect(a.captureSavestate()).toEqual({ stackWalks: [] });
    });

    test("a module that is only loaded is covered once the worker's boot sequence has run on it", () => {
        const flag = globalThis as { __savestates?: unknown };
        const touched = { touchedModules: () => ["dbghelp"] };
        const before = savestateParticipants.all().find(p => p.id === "dbghelp");
        expect(coverageRefusal(touched)).toBe("savestate: no participant captures dbghelp");
        flag.__savestates = true;
        try {
            const booted = new DbgHelp({} as never);
            booted.initialize({} as never);
            expect(coverageRefusal(touched)).toBeNull();
            const mine = savestateParticipants.all().find(p => p.id === "dbghelp")!;
            expect(mine.capture({} as never)).toEqual({ stackWalks: [] });
            savestateParticipants.add(mine)();
            if (before) savestateParticipants.add(before);
        } finally {
            delete flag.__savestates;
        }
        expect(coverageRefusal(touched)).toBe("savestate: no participant captures dbghelp");
    });

    test("the worker initializes every module it registers, so none is loaded without its participant", () => {
        const worker = readFileSync(join(import.meta.dir, "..", "..", "src", "worker", "emulator.worker.ts"), "utf8");
        const registered = [...worker.matchAll(/process\.registerModule\((\w+)\.name, \1\)/g)].map(m => m[1]!);
        const initialized = new Set([...worker.matchAll(/(\w+)\.initialize\(process\)/g)].map(m => m[1]!));
        expect(registered).toContain("dbghelp");
        expect(registered.length).toBeGreaterThan(40);
        expect(registered.filter(name => !initialized.has(name))).toEqual([]);
    });

    test("the registered participant covers dbghelp and has a pinned schema", () => {
        const undo = module().registerSavestate();
        try {
            expect(savestateParticipants.coveredModules().has("dbghelp")).toBe(true);
            expect(savestateParticipants.schemas().dbghelp).toEqual({ version: 1, schemaHash: "dfedebd0cbed9480" });
            expect(savestateParticipants.all().find(p => p.id === "dbghelp")!.capture({} as never)).toEqual({ stackWalks: [] });
        } finally {
            undo();
        }
        expect(savestateParticipants.coveredModules().has("dbghelp")).toBe(false);
    });
});
