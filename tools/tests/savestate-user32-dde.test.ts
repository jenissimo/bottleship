import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { savestateParticipants, type Participant } from "../../src/worker/savestate/participant";
import { newCaptureRun } from "../../src/worker/savestate/session";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createInputExports, type User32InputState } from "../../src/worker/modules/user32/input";

const DNS_REGISTER = 0x0001;
const APPCMD_CLIENTONLY = 0x10;
const DMLERR_NO_ERROR = 0;
const DMLERR_DLL_USAGE = 0x4004;
const DMLERR_INVALIDPARAMETER = 0x4006;
const DMLERR_NO_CONV_ESTABLISHED = 0x400a;
const PID = 0x100, STR = 0x200, OUT = 0x400;

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

type Api = ReturnType<typeof createInputExports>;
const flag = globalThis as { __savestates?: unknown };
const savedMem = Object.getOwnPropertyDescriptors(Mem);
let mem: Uint8Array;

const participant = (): Participant => savestateParticipants.all().find(p => p.id === "user32-input")!;
const capture = () => participant().capture(newCaptureRun()) as unknown as User32InputState;
const restore = (s: User32InputState) => participant().restore(structuredClone(s) as unknown as SaveValue, { object: () => null });

const session = (): Api => createInputExports();
const call = (api: Api, name: string, ...args: number[]) => (api[name]!({} as never, mem, args) as number) >>> 0;
function init(api: Api, afCmd = 0): number {
    expect(call(api, "DdeInitializeA", PID, 0x401000, afCmd, 0)).toBe(DMLERR_NO_ERROR);
    return Mem.readUint32(PID)!;
}
function hsz(api: Api, inst: number, text: string): number {
    mem.set(new TextEncoder().encode(text + "\0"), STR);
    return call(api, "DdeCreateStringHandleA", inst, STR, 1004);
}
function text(api: Api, inst: number, handle: number): string {
    const n = call(api, "DdeQueryStringA", inst, handle, OUT, 64, 1004);
    return new TextDecoder().decode(mem.subarray(OUT, OUT + n));
}

interface Used { api: Api; server: number; client: number; service: number; topic: number; conv: number }
function used(): Used {
    const api = session();
    const server = init(api);
    const client = init(api, APPCMD_CLIENTONLY);
    const service = hsz(api, server, "SaveService"), topic = hsz(api, server, "System");
    expect(call(api, "DdeNameService", server, service, 0, DNS_REGISTER)).toBe(1);
    expect(call(api, "DdeNameService", client, service, 0, DNS_REGISTER)).toBe(0);
    const conv = call(api, "DdeConnect", client, service, topic, 0);
    expect(conv).toBeGreaterThan(0);
    return { api, server, client, service, topic, conv };
}

beforeEach(() => {
    flag.__savestates = true;
    mem = new Uint8Array(0x1000);
    Mem.bind(() => mem);
});
afterEach(() => {
    delete flag.__savestates;
    for (const key of ["memoryGetter", "validateRange", "getRegion"]) Object.defineProperty(Mem, key, savedMem[key]!);
});

describe("user32 DDE in the user32-input participant", () => {
    test("an instance without a conversation is saved, not refused", () => {
        const api = session();
        const inst = init(api);
        const state = capture();
        expect(state.ddeInstances).toEqual([inst]);
        expect(state.ddeConversations).toEqual([]);
    });

    test("instances, services, strings, errors and conversations work in a fresh session as they did before the save", () => {
        const a = used();
        expect(call(a.api, "DdeNameService", a.client, a.service, 0, DNS_REGISTER)).toBe(0);
        const saved = structuredClone(capture());
        expect(saved.ddeInstances).toEqual([a.server, a.client]);
        expect(saved.ddeConversations).toEqual([a.conv]);

        const api = session();
        expect(call(api, "DdeGetLastError", a.server)).toBe(DMLERR_INVALIDPARAMETER);
        expect(call(api, "DdeDisconnect", a.conv)).toBe(0);
        restore(saved);
        expect(bytes(capture())).toBe(bytes(saved));

        expect(text(api, a.server, a.service)).toBe("SaveService");
        expect(call(api, "DdeGetLastError", a.client)).toBe(DMLERR_DLL_USAGE);
        expect(text(api, a.client, a.topic)).toBe("System");
        expect(call(api, "DdeGetLastError", a.server)).toBe(DMLERR_NO_ERROR);
        expect(call(api, "DdeNameService", a.client, a.service, 0, DNS_REGISTER)).toBe(0);
        expect(call(api, "DdeGetLastError", a.client)).toBe(DMLERR_DLL_USAGE);

        const again = call(api, "DdeConnect", a.client, hsz(api, a.client, "saveservice"), a.topic, 0);
        expect(again).toBe(a.conv + 1);
        expect(call(api, "DdeClientTransaction", 0, 0, a.conv, 0, 0, 0, 0, 0)).toBe(a.conv);
        expect(call(api, "DdeDisconnect", a.conv)).toBe(1);
        expect(call(api, "DdeDisconnect", a.conv)).toBe(0);
        expect(call(api, "DdeDisconnect", again)).toBe(1);
        expect(capture().ddeConversations).toEqual([]);

        expect(call(api, "DdeUninitialize", a.server)).toBe(1);
        expect(call(api, "DdeUninitialize", a.server)).toBe(0);
        expect(call(api, "DdeConnect", a.client, a.service, a.topic, 0)).toBe(0);
        expect(call(api, "DdeGetLastError", a.client)).toBe(DMLERR_NO_CONV_ESTABLISHED);
        expect(init(api)).toBe(a.client + 1);
        expect(hsz(api, a.client, "Next")).toBe(a.topic + 2);
        expect(call(api, "DdeUninitialize", a.client)).toBe(1);
        const end = capture();
        expect(end.ddeInstances).toEqual([a.client + 1]);
        expect(end.ddeServices).toEqual([]);
        expect(end.ddeClientOnly).toEqual([]);
    });

    test("a restore replaces the instances and conversations of the session it lands in", () => {
        const a = used();
        const saved = structuredClone(capture());
        const api = session();
        const stray = init(api), other = init(api);
        const strayConv = call(api, "DdeConnect", other, hsz(api, other, "Progman"), hsz(api, other, "Progman"), 0);
        expect(strayConv).toBeGreaterThan(0);
        expect(stray).toBe(a.server);
        restore(saved);
        expect(capture().ddeInstances).toEqual([a.server, a.client]);
        expect(capture().ddeConversations).toEqual([a.conv]);

        restore({ ...saved, ddeInstances: [], ddeConversations: [], ddeLastError: [], ddeClientOnly: [], ddeServices: [] });
        expect(call(api, "DdeGetLastError", a.server)).toBe(DMLERR_INVALIDPARAMETER);
        expect(call(api, "DdeUninitialize", a.server)).toBe(0);
        expect(call(api, "DdeDisconnect", a.conv)).toBe(0);
    });

    test("every saved DDE field reaches the capture and survives a restore", () => {
        used();
        const base = structuredClone(capture());
        const values: Omit<User32InputState, "windowProperties" | "heldKeys" | "heldButtons"> = {
            nextDdeInstance: 9, nextDdeStringHandle: 12, nextDdeConv: 5,
            ddeStrings: [[7, "Other"]], ddeServices: [["other", [4, 6]]], ddeLastError: [[4, DMLERR_DLL_USAGE]], ddeClientOnly: [6],
            ddeInstances: [4, 6], ddeConversations: [0xd0000003, 0xd0000004],
        };
        expect(Object.keys({ ...values, windowProperties: [], heldKeys: [], heldButtons: 0 }).sort()).toEqual(Object.keys(base).sort());
        for (const [field, value] of Object.entries(values) as Array<[keyof User32InputState, unknown]>) {
            expect({ field, same: bytes(value) === bytes(base[field]) }).toEqual({ field, same: false });
            session();
            restore({ ...base, [field]: value } as User32InputState);
            expect({ field, value: bytes(capture()[field]) }).toEqual({ field, value: bytes(value) });
        }
    });

    test("the restored instance set decides which calls are accepted", () => {
        const a = used();
        const saved = structuredClone(capture());
        const api = session();
        restore({ ...saved, ddeInstances: [a.client] });
        expect(call(api, "DdeGetLastError", a.server)).toBe(DMLERR_INVALIDPARAMETER);
        expect(hsz(api, a.server, "x")).toBe(0);
        expect(call(api, "DdeGetLastError", a.client)).toBe(DMLERR_NO_ERROR);
        restore({ ...saved, ddeConversations: [a.conv, a.conv + 7] });
        expect(call(api, "DdeDisconnect", a.conv + 7)).toBe(1);
        expect(call(api, "DdeDisconnect", a.conv)).toBe(1);
    });
});
