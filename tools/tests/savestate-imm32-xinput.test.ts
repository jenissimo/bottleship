import { afterEach, describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { Imm32, IMM32_FIELDS } from "../../src/worker/modules/imm32";
import { ImmContextTable, IMM_CONTEXT_TABLE_FIELDS, type ImmWindowHost } from "../../src/worker/modules/imm32-context";
import { XInput1_3, XINPUT_FIELDS } from "../../src/worker/modules/xinput1_3";
import { savestateParticipants } from "../../src/worker/savestate/participant";
import { preserveGlobals } from "./helpers/scoped-globals";

preserveGlobals("__savestates");

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};
type Internals = Record<string, any>;

const undo: Array<() => void> = [];
afterEach(() => {
    while (undo.length) undo.pop()!();
    delete (globalThis as { __savestates?: boolean }).__savestates;
});

function host(thread = 7): ImmWindowHost {
    const owners = new Map<number, number>([[0x10010, thread], [0x10020, thread], [0x10030, 9]]);
    return {
        currentThreadId: () => thread,
        windowThread: (hwnd) => owners.get(hwnd >>> 0),
        descendants: (hwnd) => (hwnd === 0x10010 ? [0x10020] : []),
    };
}

function busyTable(): ImmContextTable {
    const t = new ImmContextTable(host());
    const own = t.create();
    t.defaultContext(9);
    t.associate(0x10010, own);
    t.associate(0x10020, 0);
    (t as unknown as Internals).contexts.get(own).hInputContext = 0x4242;
    return t;
}

describe("imm32 participant", () => {
    test("every instance field has a policy", () => {
        expect(Object.keys(new Imm32()).sort()).toEqual(Object.keys(IMM32_FIELDS).sort());
        expect(Object.keys(new ImmContextTable(host())).sort()).toEqual(Object.keys(IMM_CONTEXT_TABLE_FIELDS).sort());
    });

    test("contexts, defaults, associations and IME windows round trip; the next handle continues where it was", () => {
        const m = new Imm32() as Imm32 & Internals;
        m.contexts = busyTable();
        m.imeWindows.set(7, 0x10090);
        const first = m.captureSavestate();
        const fresh = new Imm32() as Imm32 & Internals;
        fresh.contexts = new ImmContextTable(host());
        fresh.contexts.create();
        fresh.imeWindows.set(3, 0x10077);
        fresh.restoreSavestate(structuredClone(first));
        expect(bytes(fresh.captureSavestate())).toBe(bytes(first));
        expect(fresh.imeWindows.has(3)).toBe(false);
        const t = fresh.contexts as ImmContextTable;
        expect(t.windowContext(0x10010)).toBe(m.contexts.windowContext(0x10010));
        expect(t.windowContext(0x10020)).toBe(0);
        expect(t.create()).toBe((m.contexts as ImmContextTable).create());
    });

    test("each saved part reaches the capture", () => {
        const m = new Imm32() as Imm32 & Internals;
        m.contexts = busyTable();
        m.imeWindows.set(7, 0x10090);
        const before = bytes(m.captureSavestate());
        const t = m.contexts as Internals;
        const rec = [...t.contexts.values()][0];
        for (const [obj, key, delta] of [[rec, "threadId", 1], [rec, "hInputContext", 4], [t, "nextHimc", 4]] as Array<[Internals, string, number]>) {
            obj[key] += delta;
            expect(bytes(m.captureSavestate())).not.toBe(before);
            obj[key] -= delta;
        }
        rec.isDefault = !rec.isDefault;
        expect(bytes(m.captureSavestate())).not.toBe(before);
        rec.isDefault = !rec.isDefault;
        t.associations.set(0x10030, 0);
        expect(bytes(m.captureSavestate())).not.toBe(before);
        t.associations.delete(0x10030);
        t.defaultByThread.set(11, 0x11100);
        expect(bytes(m.captureSavestate())).not.toBe(before);
        t.defaultByThread.delete(11);
        m.imeWindows.set(8, 1);
        expect(bytes(m.captureSavestate())).not.toBe(before);
        m.imeWindows.delete(8);
        expect(bytes(m.captureSavestate())).toBe(before);
    });

    test("registers only with savestates on, covers imm32 with a pinned schema, and the undo removes it", () => {
        const quiet = new Imm32() as Imm32 & Internals;
        quiet.destroyObserverRegistered = true;
        quiet.initialize({} as never);
        expect(savestateParticipants.coveredModules().has("imm32")).toBe(false);
        const off = new Imm32().registerSavestate();
        try {
            expect(savestateParticipants.coveredModules().has("imm32")).toBe(true);
            expect(savestateParticipants.schemas().imm32).toEqual({ version: 1, schemaHash: "5fd012243a1898bc" });
        } finally {
            off();
        }
        expect(savestateParticipants.coveredModules().has("imm32")).toBe(false);
    });
});

describe("xinput1_3 participant", () => {
    test("every instance field has a policy", () => {
        expect(Object.keys(new XInput1_3()).sort()).toEqual(Object.keys(XINPUT_FIELDS).sort());
    });

    test("the packet number, the snapshot it describes and the queued keystrokes round trip", () => {
        const x = new XInput1_3() as XInput1_3 & Internals;
        x.enabled = false;
        x.packetNumber = 0xfffffffe;
        x.lastSnapshotKey = "1|4096|0|0|0|0|0|0";
        x.keystrokes.push({ virtualKey: 0x5800, flags: 1 }, { virtualKey: 0x5800, flags: 2 });
        x.keystrokeButtons = 0x1000;
        x.keystrokeLeftDir = 5;
        x.keystrokeRightDir = 3;
        x.keystrokeSeeded = true;
        x.announced.add("XInputGetState");
        const first = x.captureSavestate();
        const fresh = new XInput1_3() as XInput1_3 & Internals;
        fresh.keystrokes.push({ virtualKey: 1, flags: 1 });
        fresh.restoreSavestate(structuredClone(first));
        expect(bytes(fresh.captureSavestate())).toBe(bytes(first));
        expect(fresh.keystrokes).toEqual([{ virtualKey: 0x5800, flags: 1 }, { virtualKey: 0x5800, flags: 2 }]);
        expect(fresh.announced.size).toBe(0);
    });

    test("each saved field reaches the capture", () => {
        const x = new XInput1_3() as XInput1_3 & Internals;
        x.keystrokes.push({ virtualKey: 0x5801, flags: 1 });
        const before = bytes(x.captureSavestate());
        for (const key of Object.entries(XINPUT_FIELDS).filter(([, p]) => p === "save").map(([k]) => k)) {
            const old = x[key];
            if (key === "keystrokes") x.keystrokes[0].flags = 2;
            else x[key] = typeof old === "boolean" ? !old : typeof old === "string" ? old + "x" : old + 1;
            expect(bytes(x.captureSavestate())).not.toBe(before);
            if (key === "keystrokes") x.keystrokes[0].flags = 1;
            else x[key] = old;
        }
        expect(bytes(x.captureSavestate())).toBe(before);
    });

    test("registers only with savestates on, covers xinput1_3 with a pinned schema, and the undo removes it", () => {
        new XInput1_3().initialize({} as never);
        expect(savestateParticipants.coveredModules().has("xinput1_3")).toBe(false);
        const off = new XInput1_3().registerSavestate();
        try {
            expect(savestateParticipants.coveredModules().has("xinput1_3")).toBe(true);
            expect(savestateParticipants.schemas().xinput1_3).toEqual({ version: 1, schemaHash: "78d4d081771bd1ad" });
        } finally {
            off();
        }
        expect(savestateParticipants.coveredModules().has("xinput1_3")).toBe(false);
    });
});
